import { rawQuery } from "./db.js";
import { invalidateContentCaches } from "./cache.js";
import { createLogger } from "./logger.js";
import { enqueueSweep, retryFailedSendsThrottled } from "./newsletter.js";
import { rollupVisitDaily } from "./visit-sources.js";

const log = createLogger("publish");

// R241 leftover: scheduled publishing is a TIME GATE, not a status flip
// (queries.publishedVisible: status='published' AND (publishedAt is null OR
// publishedAt <= now())). The row becomes visible the instant now() passes it,
// but every public surface caches the PRE-due answer: the `pg:`/`pgh:`/`counts:`
// memos hold it for SIDEBAR_TTL (30s, and up to 5x that while SWR keeps serving
// stale), and the loader KV entries for 60-300s. Nothing ever dropped them at
// the due moment, so a post scheduled for 09:00 appeared whenever those TTLs
// happened to expire - minutes late, while the admin list already said it was
// live. A manual publish does not have this problem because the write path
// calls invalidateContentCaches() at its commit point; the gate has no such
// commit point.
//
// Hence one cheap pass per minute instead of a per-request hook: the same
// invalidation a manual publish runs, applied to rows that crossed the gate
// since the previous pass. It is a no-op - one query, no writes - on every
// minute where nothing came due.
//
// Measured on PGlite, 5 000 rows per table, nothing due: posts ride
// posts_status_published_idx (status, published_at) as an Index Only Scan,
// 0.36 ms. pages have no (status, published_at) index, so they take
// pages_status_idx and filter published_at in the index: 2.3 ms at 5 000 pages.
// A real site has orders of magnitude fewer pages than that, so this stays a
// rounding error against a 60 s tick.
// shortcut: pages pay a status-index scan instead of a range scan; add
// pages_status_published_idx if the pages table ever reaches the thousands.

const SWEEP_INTERVAL = 60_000;

/**
 * One pass: did any post/page cross the visibility gate during the last
 * `windowMs`? If so drop the content caches, exactly as a manual publish would.
 *
 * Returns how many rows just became visible (0 for the steady-state minute).
 * The window is measured on the DB clock (`now()` both sides), so it cannot
 * drift from the timestamps it is compared against.
 *
 * The newsletter fanout rides the same tick and the SAME window: a post that
 * just crossed the gate is exactly the one subscribers have not been told
 * about. The two passes share one timer and one re-entrancy guard, so neither
 * can double-run against the other; newsletter claims its sends in
 * newsletter_sends (ON CONFLICT DO NOTHING), so even a doubled pass could not
 * double-send. An enqueueSweep failure throws through sweepOnce on purpose:
 * the tick keeps `lastPass` where it was and retries the whole span next tick
 * (the sends ledger makes that retry a no-op for anything already claimed),
 * and a post that came due while the fanout was failing is never lost. With
 * no SMTP configured the fanout resolves to 0 sends without error.
 *
 * The same tick also owns the failed-delivery retry (newsletter's
 * retryFailedSendsThrottled, over the ledger's failed_at column —
 * db/migrations/0036): a claim row is not evidence of a delivered mail, so a
 * row whose SMTP session failed must be picked up again or the post is lost
 * for that subscriber forever. The pass is throttled (RETRY_THROTTLE_MS) so a
 * dead server does not open one session per failed row on every minute.
 */
export async function sweepOnce(windowMs = SWEEP_INTERVAL): Promise<number> {
  const window = Math.max(1, Math.trunc(windowMs));
  const [row] = await rawQuery<{ n: number | string }>(
    `select
       (select count(*) from posts
         where status = 'published' and published_at is not null
           and published_at <= now()
           and published_at > now() - ($1::int * interval '1 millisecond'))
     + (select count(*) from pages
         where status = 'published' and published_at is not null
           and published_at <= now()
           and published_at > now() - ($1::int * interval '1 millisecond')) as n`,
    [window],
  );
  const due = Number(row?.n ?? 0);
  // Same call the admin publish path makes, so a scheduled flip and a manual
  // one are indistinguishable to every cache in front of them.
  if (due > 0) invalidateContentCaches();
  // Newsletter fanout (details in the docblock above).
  await enqueueSweep(window);
  // R250 failed-delivery retry, same beat. Throttled inside — a dead SMTP
  // server must not open one session per minute, and the pass never throws
  // (it warns and answers zeroes), so it cannot fail this tick's window.
  await retryFailedSendsThrottled();
  // R255 traffic sources, same beat. Recomputes visit_daily for today and
  // yesterday from post_visitors and upserts ABSOLUTE counts, so a rerun (or a
  // second instance sweeping the same minute) cannot double them. Never throws
  // (warns and returns), for the same reason the retry above does not: a broken
  // provenance column must not stop `lastPass` from advancing and replay the
  // whole publish window on the next tick.
  await rollupVisitDaily();
  return due;
}

let stopFn: (() => void) | undefined;

/**
 * Run the due sweep on the process's own clock.
 *
 * The first pass is deliberately NOT immediate: a deploy/restart is already the
 * busiest moment for the DB, and on a cold process every cache is empty, so
 * there is nothing stale to drop yet. unref'd so the sweeper alone never keeps
 * the event loop open, and cleared on framework shutdown - the same shape as
 * startRetention (retention.ts:190). Calling it twice returns the same stop, so
 * a hot-reloaded module cannot stack timers.
 */
export function startPublishSweeper(intervalMs = SWEEP_INTERVAL): () => void {
  if (stopFn) return stopFn;
  let lastPass = Date.now();
  let running = false;
  const tick = () => {
    // Re-entrancy: a pass slower than the interval (a cold DB, a lock) must not
    // stack a second one on top of it.
    if (running) return;
    running = true;
    // Elapsed, not the configured interval: a late tick widens its own window
    // instead of leaving a hole of rows nobody ever sees come due. `lastPass`
    // only moves on SUCCESS, so a failed pass is retried over the same span
    // rather than silently skipped.
    const windowMs = Date.now() - lastPass;
    void sweepOnce(windowMs)
      .then(() => {
        lastPass = Date.now();
      })
      .catch((err) => log.warn("[publish] due sweep failed:", err))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  const stop = () => {
    clearInterval(timer);
    if (stopFn === stop) stopFn = undefined;
  };
  const g = globalThis as unknown as {
    __rosezmOnShutdown?: (name: string, f: () => void | Promise<void>) => () => void;
  };
  if (typeof g.__rosezmOnShutdown === "function") g.__rosezmOnShutdown("publish-sweeper", stop);
  stopFn = stop;
  return stop;
}
