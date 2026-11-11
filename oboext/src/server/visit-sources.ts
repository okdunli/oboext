// Daily traffic rollup (db/migrations/0041, visit_daily).
//
// WHY THIS IS NOT ON THE REQUEST PATH: incrementViews() writes the visitor row
// and the posts counter in ONE statement (a CTE). Adding a second INSERT into
// visit_daily per pageview would undo exactly the single round trip that
// comment protects - and at Neon RTT that is the whole point of the CTE. So the
// request path only records the raw observation (post_visitors.referrer_kind);
// the aggregation runs on the publish sweeper's existing minute tick.
//
// WHY ABSOLUTE VALUES: each pass recomputes the counts for a whole day and
// upserts them with `views = excluded.views`. A rerun, a slow pass, a second
// application instance, or a process that died mid-sweep all converge on the
// same numbers. An `views + excluded.views` upsert would double them on the
// first retry, and every retry after that.
//
// WHY TWO DAYS: recomputing `current_date - 1` as well as today closes the
// midnight edge. A visit at 23:59:58 lands in the previous day; if only "today"
// were recomputed, a pass that ran three seconds before midnight would write a
// partial yesterday and never revisit it.
//
// HONEST LIMITS, so the dashboard label does not promise more than the data:
//   - post_visitors is a FIRST-VISIT ledger (INSERT ... ON CONFLICT DO NOTHING),
//     so one visitor reading the same post twice produces one row. `views` here
//     is therefore "landing visits", and `uniques` is equal to it by
//     construction (`count(*)` IS the distinct-visitor count for a unique
//     (post_id, visitor_key) row). The pair exists so a per-visit ledger can
//     fill `views` later without reshaping the dashboard payload.
//   - The rows are per (day, POST, kind). A dashboard that sums `uniques`
//     across posts is summing "distinct visitors per post", which is larger
//     than the site's unique visitors. The UI says 访次/访客, not 独立访客.
//   - A returning visitor's referrer is never recorded: the INSERT conflicts
//     and does nothing, so the stored kind is the one from the FIRST landing.
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./db.js";
import { postVisitors, posts, visitDaily } from "./schema.js";
import { createLogger } from "./logger.js";
import { siteTimeZone } from "./queries.js";
import { invalidatePrefix, memoQuery } from "./cache.js";

const log = createLogger("visits");

/** One row of the dashboard's "where does today's traffic come from" card. */
export type VisitSourceRow = {
  kind: string;
  views: number;
  uniques: number;
};

/**
 * One row of the "which posts does this channel send traffic to" table (R256):
 * the posts a single referrer_kind landed on, largest first.
 */
export type SourcePostRow = {
  kind: string;
  postId: number;
  title: string;
  views: number;
};

/** `day >= current_date - (days - 1)` — today plus the previous `days-1`
 *  calendar days, computed in SQL so the window never depends on the app's
 *  timezone agreeing with the one that stamped the rows. */
async function dayWindow(days: number) {
  const n = Math.max(1, Math.trunc(Number(days) || 1));
  return gte(visitDaily.day, sql`${dayLabelOffset(await todayLabel(), n - 1)}`);
}

/** The site-tz calendar day `back` days before today, as YYYY-MM-DD. Rows in
 *  visit_daily are stamped with the site's own day, so readers must ask in the
 *  same calendar - `current_date` is the DB session's (UTC) day. */
function zonedDay(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
async function todayLabel(): Promise<string> {
  return zonedDay(new Date(), await siteTimeZone());
}
function dayLabelOffset(base: string, back: number): string {
  const anchor = new Date(`${base}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - back);
  return anchor.toISOString().slice(0, 10);
}

/**
 * Recompute visit_daily for today and yesterday. Idempotent by construction:
 * every pass writes the absolute count for each (day, post, kind) bucket.
 *
 * A failure is warned and swallowed. This rides the publish sweeper's tick,
 * where a throw would stop `lastPass` from advancing and replay the whole
 * publish window - a broken provenance column must never hold back scheduled
 * posts. The next tick retries the same two days, and because the write is
 * absolute, a missed pass costs nothing once one succeeds.
 */
export async function rollupVisitDaily(): Promise<void> {
  try {
    const tz = await siteTimeZone();
    await db.execute(sql`
      insert into ${visitDaily} ("day", "post_id", "referrer_kind", "views", "uniques")
      select (pv."created_at" AT TIME ZONE ${tz})::date           as "day",
             pv."post_id"                                         as "post_id",
             coalesce(pv."referrer_kind", 'direct')               as "referrer_kind",
             count(*)::int                                        as "views",
             count(*)::int                                        as "uniques"
        from ${postVisitors} pv
       where pv."created_at" >= now() - interval '3 days'
       group by 1, 2, 3
      on conflict ("day", "post_id", "referrer_kind")
      do update set views = excluded.views, uniques = excluded.uniques`);
      invalidatePrefix("vst:");
      invalidatePrefix("vsp:");
  } catch (e) {
    log.warn("[visits] daily rollup failed:", e);
  }
}

/**
 * Today's traffic by source, largest first. Reads only visit_daily - never the
 * raw ledger - so the dashboard costs one indexed range scan no matter how big
 * post_visitors has grown.
 *
 * An empty table yields an empty array, not fabricated zero rows: before the
 * first rollup pass there is genuinely no data, and a card that invents five
 * zeroes would look identical to a site with no traffic.
 */
export async function visitSourcesToday(): Promise<VisitSourceRow[]> {
  const day = await todayLabel();
  return memoQuery(`vst:${day}`, 30_000, async () => {
    const rows = await db
      .select({
        kind: visitDaily.referrerKind,
        views: sql<number>`coalesce(sum(${visitDaily.views}), 0)::int`,
        uniques: sql<number>`coalesce(sum(${visitDaily.uniques}), 0)::int`,
      })
      .from(visitDaily)
      .where(sql`${visitDaily.day} = ${day}`)
      .groupBy(visitDaily.referrerKind)
      .orderBy(sql`coalesce(sum(${visitDaily.views}), 0) desc`, visitDaily.referrerKind);
    return rows.map((r) => ({ kind: r.kind, views: Number(r.views), uniques: Number(r.uniques) }));
  });
}

/**
 * One post's traffic by source over the last `days` days (default 30), largest
 * first. The post editor's "近 30 天来源" summary reads this.
 *
 * Read-only against visit_daily, like every other reader here: the raw ledger
 * (post_visitors) is never touched, and a post id that has never been rolled
 * up answers [] rather than zero rows for all five kinds - the same "no data is
 * not the same as zero" rule the dashboard card follows.
 */
export async function visitSourcesForPost(postId: number, days = 30): Promise<VisitSourceRow[]> {
  const rows = await db
    .select({
      kind: visitDaily.referrerKind,
      views: sql<number>`coalesce(sum(${visitDaily.views}), 0)::int`,
      uniques: sql<number>`coalesce(sum(${visitDaily.uniques}), 0)::int`,
    })
    .from(visitDaily)
    .where(and(eq(visitDaily.postId, postId), await dayWindow(days)))
    .groupBy(visitDaily.referrerKind)
    .orderBy(sql`coalesce(sum(${visitDaily.views}), 0) desc`, visitDaily.referrerKind);
  return rows.map((r) => ({ kind: r.kind, views: Number(r.views), uniques: Number(r.uniques) }));
}

/**
 * The posts a single channel sent the most visits to over the last `days` days
 * (default 7), largest first, capped at `limit`. The dashboard's
 * "来源 × 文章" table reads this once per referrer_kind.
 *
 * `kind` is matched verbatim (the stored vocabulary from referrer.ts), so an
 * unknown kind returns [] instead of falling back to "every post" - a typo in a
 * caller must fail visibly empty, never silently broad.
 */
export async function topPostsBySource(kind: string, days = 7, limit = 10): Promise<SourcePostRow[]> {
  const take = Math.max(0, Math.trunc(Number(limit) || 0));
  const rows = await db
    .select({
      postId: visitDaily.postId,
      title: posts.title,
      views: sql<number>`coalesce(sum(${visitDaily.views}), 0)::int`,
    })
    .from(visitDaily)
    .innerJoin(posts, eq(posts.id, visitDaily.postId))
    .where(and(eq(visitDaily.referrerKind, kind), await dayWindow(days)))
    .groupBy(visitDaily.postId, posts.title)
    .orderBy(sql`coalesce(sum(${visitDaily.views}), 0) desc`, visitDaily.postId)
    .limit(take);
  return rows.map((r) => ({ kind, postId: r.postId, title: r.title, views: Number(r.views) }));
}

/**
 * Delete raw visitor ledger rows older than 7 days. The rollup only reads a
 * 3-day window, and visit_daily stores the historical aggregate, so anything
 * past 7 days is dead weight: a site with 10k unique visitors × 100 posts
 * accumulates 1M rows that nothing reads. The first-visit dedup for old
 * posts is lost, so a returning visitor counts again in the CURRENT day's
 * rollup — the same trade every analytics system makes when it ages out raw
 * events. */
export async function pruneVisitorLedger(): Promise<void> {
  try {
    await db.execute(sql`delete from ${postVisitors} where "created_at" < now() - interval '7 days'`);
  } catch (e) {
    log.warn("[visits] visitor ledger prune failed:", e);
  }
}
