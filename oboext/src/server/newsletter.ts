// Newsletter subscription — double opt-in, one-click unsubscribe, and the
// per-publish fanout.
//
// Shapes copied from the neighbors:
//   - subscribe/confirm/unsubscribe follow verify-codes.ts's token discipline
//     (random capability tokens in the DB, no state derivable from the email);
//   - the fanout lives behind enqueueSweep(), called from the publish sweeper's
//     tick, and SMTP is never sent inside a request (comment-mail-notify's
//     fire-and-forget rule);
//   - the per-(post, subscriber) send ledger (newsletter_sends) is claimed with
//     INSERT ... ON CONFLICT DO NOTHING, so a concurrent sweep or a second
//     instance cannot double-send;
//   - the ledger is claimed BEFORE the mail goes out, so a claim row is not
//     evidence of a delivery. failed_at (db/migrations/0036) is the repair for
//     that ordering: NULL = delivered, a timestamp = the delivery failed and
//     retryFailedSends() owns the row again. Without it, one SMTP hiccup made
//     a post permanently lost for the subscriber whose row was already claimed.
//
// Caching: subscriber state is written and read for the user's own actions and
// must be exact, so nothing here goes through the content memo. The reads are
// point queries / a small confirmed list — direct db reads by design.

import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db, rawQuery } from "./db.js";
import { newsletterSends, posts, subscribers } from "./schema.js";
import { getNotifySettings } from "./notify.js";
import { sendSmtpMail } from "./smtp.js";
import { getSettings } from "./queries.js";
import { getPermalinkConfig, postUrlFor } from "./links.js";
import { configuredOrigin } from "./site-origin.js";
import { ensureMigrations } from "./db.js";
import { createLogger } from "./logger.js";
import { makeT, type Locale, DEFAULT_LOCALE } from "./i18n.js";
import { ServiceError } from "./errors.js";

const log = createLogger("newsletter");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * Case-normalize a subscribe input. The email keeps its case off the wire (the
 * local part is technically case-sensitive and verify codes etc. store it as
 * typed) but the UNIQUE constraint must treat Alice@ and alice@ as one
 * subscriber, so the stored row is the lowercase form.
 */
function normalizeEmail(raw: unknown): string {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v || v.length > 254 || !EMAIL_RE.test(v)) {
    throw new ServiceError("邮箱格式不正确", 422, "api.email_invalid");
  }
  return v;
}

function normalizeLocaleTag(raw: unknown): Locale {
  return raw === "en" ? "en" : DEFAULT_LOCALE;
}

export interface SubscribeResult {
  ok: true;
  /** true = a confirmation mail was (re)sent; false = already confirmed. */
  pending: boolean;
}

/**
 * Subscribe an email.
 *
 * Returns { ok: true } in every non-error case and NEVER reveals whether the
 * address already exists beyond what the flow itself implies — a confirmed
 * subscriber's repeat POST is the same ok as a brand-new one, so this endpoint
 * cannot be used to probe who is on the list.
 *
 *   - new address        -> insert + send confirmation (pending: true)
 *   - unconfirmed repeat  -> fresh token + resend confirmation (pending: true)
 *   - confirmed repeat    -> idempotent no-op (pending: false)
 *   - unsubscribed repeat -> reactivate + NEW token + resend (pending: true)
 *
 * The confirmation mail is fire-and-forget: the DB row is the source of truth,
 * the mail is best-effort (SMTP down, or not configured, is not the visitor's
 * error and must not fail the POST).
 */
export async function subscribe(rawEmail: unknown, rawLocale: unknown): Promise<SubscribeResult> {
  await ensureMigrations();
  const email = normalizeEmail(rawEmail);
  const locale = normalizeLocaleTag(rawLocale);
  const [existing] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.email, email))
    .limit(1);

  if (!existing) {
    await db.insert(subscribers).values({
      email,
      locale,
      token: randomBytes(24).toString("hex"),
    });
    void sendConfirmation(email, locale).catch((e) =>
      log.warn("[newsletter] confirm mail failed:", e instanceof Error ? e.message : String(e)),
    );
    return { ok: true, pending: true };
  }

  if (existing.confirmedAt && !existing.unsubscribedAt) {
    // Confirmed and active: nothing to do, nothing to leak.
    return { ok: true, pending: false };
  }

  // Unconfirmed (or previously unsubscribed): mint a fresh token so an old
  // confirm link can never confirm an address the current mailbox owner did
  // not re-request, and re-activate the row in place.
  await db
    .update(subscribers)
    .set({
      token: randomBytes(24).toString("hex"),
      locale,
      unsubscribedAt: null,
      confirmedAt: null,
    })
    .where(eq(subscribers.id, existing.id));
  void sendConfirmation(email, locale).catch((e) =>
    log.warn("[newsletter] confirm mail failed:", e instanceof Error ? e.message : String(e)),
  );
  return { ok: true, pending: true };
}

/** Confirm an address by its token. False for an unknown/consumed token. */
export async function confirm(rawToken: unknown): Promise<boolean> {
  await ensureMigrations();
  const token = String(rawToken ?? "").trim();
  if (!token) return false;
  const [row] = await db
    .select({ id: subscribers.id, confirmedAt: subscribers.confirmedAt })
    .from(subscribers)
    .where(eq(subscribers.token, token))
    .limit(1);
  if (!row) return false;
  if (!row.confirmedAt) {
    await db
      .update(subscribers)
      .set({ confirmedAt: new Date() })
      .where(eq(subscribers.id, row.id));
  }
  return true;
}

/**
 * One-click unsubscribe: the token IS the credential (it rides the mail's
 * List-Unsubscribe link), so no extra form. Idempotent; false for an unknown
 * token.
 */
export async function unsubscribe(rawToken: unknown): Promise<boolean> {
  await ensureMigrations();
  const token = String(rawToken ?? "").trim();
  if (!token) return false;
  const [row] = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(eq(subscribers.token, token))
    .limit(1);
  if (!row) return false;
  await db
    .update(subscribers)
    .set({ unsubscribedAt: new Date() })
    .where(eq(subscribers.id, row.id));
  return true;
}

// ------------------------------------------------------------------- sending

async function smtpReady(): Promise<boolean> {
  const notify = await getNotifySettings();
  return Boolean(notify.smtp.host);
}

/**
 * The double-opt-in confirmation mail. Fire-and-forget by contract: callers
 * `void` this and catch. Silent no-op when SMTP is not configured — an
 * unconfigured site is a normal state, not an error.
 */
async function sendConfirmation(email: string, locale: Locale): Promise<void> {
  if (!(await smtpReady())) {
    log.debug("[newsletter] smtp not configured, skip confirm mail");
    return;
  }
  const notify = await getNotifySettings();
  const site = await getSettings();
  const siteName = String(site.siteTitle || "Oboext");
  const origin = configuredOrigin(process.env);
  const t = makeT(locale);

  const token = await readToken(email);
  const confirmHref = `${origin}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
  const html =
    `<div style="padding:24px;font-family:system-ui,sans-serif">` +
    `<h2 style="margin:0 0 12px">${escapeHtml(siteName)}</h2>` +
    `<p>${t("newsletter.mail_confirm_lead", { site: siteName })}</p>` +
    `<p><a href="${confirmHref}">${t("newsletter.mail_confirm_cta")}</a></p>` +
    `<p style="color:#888;font-size:12px">${t("newsletter.mail_foot")}</p>` +
    `</div>`;
  const text = `${t("newsletter.mail_confirm_lead", { site: siteName })}\n${confirmHref}\n${t("newsletter.mail_foot")}`;

  await sendSmtpMail(
    {
      host: notify.smtp.host,
      port: notify.smtp.port,
      security: notify.smtp.security,
      user: notify.smtp.user,
      pass: notify.smtp.pass,
      from: notify.smtp.from || notify.smtp.user,
    },
    {
      to: email,
      subject: t("newsletter.mail_confirm_subject", { site: siteName }),
      text,
      html,
    },
  );
}

/**
 * The token for an address we just (re)wrote. A fresh read keeps this correct
 * for every branch (insert / re-mint) without threading the token through the
 * callers.
 */
async function readToken(email: string): Promise<string> {
  const [row] = await db
    .select({ token: subscribers.token })
    .from(subscribers)
    .where(eq(subscribers.email, email))
    .limit(1);
  return row?.token ?? "";
}

interface DuePost {
  id: number;
  title: string;
  slug: string;
  publishedAt: Date | null;
  pinyinSlug: string | null;
  initialSlug: string | null;
  format: string;
}

/**
 * Fan out ONE post to every confirmed subscriber, claiming each
 * (post, subscriber) pair first with INSERT ... ON CONFLICT DO NOTHING ... RETURNING:
 * only a returned row means this call won the send. The returned number is the
 * count of newly claimed rows — 0 means every pair was already claimed (the
 * post went out before) or there is no audience.
 *
 * This is the single-article core of enqueueSweep, extracted so the admin's
 * manual send (POST /api/newsletter/send) reuses the exact same claim
 * discipline and thus the same idempotence: a hand re-run of an old post can
 * never double-send, and the R249 boundary case — a post whose publishedAt
 * lies outside the sweeper's window, e.g. a backdated edit — reaches the
 * audience through this door instead.
 */
export async function sendPostToSubscribers(postId: number): Promise<number> {
  await ensureMigrations();
  const id = Math.trunc(Number(postId));
  if (!Number.isInteger(id) || id <= 0) return 0;
  const [post] = await db
    .select({
      id: posts.id,
      title: posts.title,
      slug: posts.slug,
      publishedAt: posts.publishedAt,
      pinyinSlug: posts.pinyinSlug,
      initialSlug: posts.initialSlug,
      format: posts.format,
    })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1);
  if (!post) return 0;

  const audience: { id: number; email: string; locale: Locale }[] = (await db
    .select({ id: subscribers.id, email: subscribers.email, locale: subscribers.locale })
    .from(subscribers)
    .where(and(sql`${subscribers.confirmedAt} is not null`, isNull(subscribers.unsubscribedAt)))
  ).map((r) => ({ id: r.id, email: r.email, locale: r.locale === "en" ? "en" : DEFAULT_LOCALE }));
  if (!audience.length) return 0;

  // The claim IS the durable record: only the rows this insert returns fire.
  const rows = await db
    .insert(newsletterSends)
    .values(audience.map((s) => ({ postId: post.id, subscriberId: s.id })))
    .onConflictDoNothing()
    .returning({ subscriberId: newsletterSends.subscriberId });
  if (!rows.length) return 0;
  const winners = new Map(audience.map((s) => [s.id, s]));
  const sendSet = rows
    .map((r) => winners.get(r.subscriberId))
    .filter((s): s is (typeof audience)[number] => Boolean(s));
  if (!sendSet.length) return 0;
  // Fire-and-forget: the ledger rows above are the durable record; the mail
  // is best-effort and must never stall or fail the caller (a sweeper tick or
  // an HTTP request). The failure marker is written from INSIDE that promise:
  // a claim row is not evidence of a delivery, and a row whose mail never went
  // out must be marked failed here or every later rescan skips it forever.
  void deliverAndRecord(post, sendSet).catch((e) =>
    log.warn("[newsletter] post fanout failed:", e instanceof Error ? e.message : String(e)),
  );
  return rows.length;
}

/**
 * deliverPost + the ledger write-back. Split out so the fire-and-forget call
 * above has ONE place that cannot lose a failure: a throw from deliverPost
 * itself (settings read, permalink config) means nothing went out at all, so
 * every claimed recipient counts as failed.
 */
async function deliverAndRecord(
  post: DuePost,
  recipients: { id: number; email: string; locale: Locale }[],
): Promise<void> {
  let failed: number[];
  try {
    failed = (await deliverPost(post, recipients)).failedSubscriberIds;
  } catch (e) {
    log.warn("[newsletter] post fanout failed:", e instanceof Error ? e.message : String(e));
    failed = recipients.map((r) => r.id);
  }
  if (failed.length) await markFailed(post.id, failed);
}

/** Mark the (post, subscriber) pairs whose mail did not go out. */
async function markFailed(postId: number, subscriberIds: number[]): Promise<void> {
  if (!subscriberIds.length) return;
  await db
    .update(newsletterSends)
    .set({ failedAt: sql`now()` })
    .where(
      and(eq(newsletterSends.postId, postId), inArray(newsletterSends.subscriberId, subscriberIds)),
    );
}

/** Clear the failure marker on a pair that finally went out. */
async function markDelivered(postId: number, subscriberIds: number[]): Promise<void> {
  if (!subscriberIds.length) return;
  await db
    .update(newsletterSends)
    .set({ failedAt: null, sentAt: sql`now()` })
    .where(
      and(eq(newsletterSends.postId, postId), inArray(newsletterSends.subscriberId, subscriberIds)),
    );
}

/**
 * Fanout pass — the sweeper calls this every minute with the same windowMs the
 * due-cache sweep used.
 *
 * Semantics: a post is due when it is published AND visible (status='published'
 * AND publishedAt <= now(), i.e. the time-gate shape publishedVisible uses) AND
 * it crossed into visibility inside this window (publishedAt > now() - window).
 * The window semantics deliberately match sweepOnce's DB-clock window
 * (published_at > now() - window): measured on now() on both sides so it cannot
 * drift from the timestamps it is compared against, and only advancing on a
 * successful pass (publish-sweeper.ts holds lastPass until enqueueSweep
 * resolves), so a failed pass retries the same span. A manual publish whose
 * publishedAt was set long ago (an edit of an old post, a backdated schedule)
 * has an OLD publishedAt and is NOT inside the window — it never enters the
 * fanout here. That is the agreed cost of reusing the sweeper's mechanism:
 * newsletter fanout tracks "posts that just became visible on the clock", not
 * "rows whose status last changed inside the window". The admin-side door for
 * that case is sendPostToSubscribers() (POST /api/newsletter/send), which
 * claims through the same ledger and stays idempotent.
 *
 * Claiming: one INSERT ... ON CONFLICT DO NOTHING per (post, subscriber), via
 * sendPostToSubscribers — only a returned row means this process won the send;
 * everything else skips.
 */
export async function enqueueSweep(windowMs = 60_000): Promise<number> {
  await ensureMigrations();
  const window = Math.max(1, Math.trunc(windowMs));
  // No subscribers -> the cheapest exit: one aggregate, no post scan.
  const [{ n: activeCount }] = await rawQuery<{ n: number | string }>(
    `select count(*) as n from subscribers
      where confirmed_at is not null and unsubscribed_at is null`,
  );
  if (Number(activeCount) === 0) return 0;

  // Same index posts_status_published_idx (status, published_at) serves for the
  // due-cache sweep answers this shape.
  const due = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.status, "published"),
        // publishedVisible's exact time-gate shape: status='published' AND
        // publishedAt <= now() AND publishedAt > now() - window.
        lte(posts.publishedAt, sql`now()`),
        gt(posts.publishedAt, sql`now() - (${window}::int * interval '1 millisecond')`),
      ),
    );
  if (!due.length) return 0;

  let claimed = 0;
  for (const post of due) {
    claimed += await sendPostToSubscribers(post.id);
  }
  return claimed;
}

// ------------------------------------------------------------------- retry

export interface RetryResult {
  /** Rows the pass picked up (failed_at set, still subscribed). */
  retried: number;
  /** Rows whose mail went out this pass, so failed_at went back to NULL. */
  succeeded: number;
}

/**
 * How many failed rows the admin screen shows and one admin click retries.
 *
 * The two numbers are one contract on purpose: the detail table answers "what
 * is stuck", and the button beside it promises to work through what the
 * operator can see. They are the same rows and the same count, so a shared
 * constant keeps the page (admin-loaders.ts, the `failures` window) and the
 * admin endpoint (api/newsletter/retry) from drifting apart — a table of 20
 * with a budget of 3 would take seven clicks, and a budget larger than the
 * table would work on rows nobody was shown.
 */
export const ADMIN_RETRY_LIMIT = 20;

/**
 * Re-send the rows whose delivery failed.
 *
 * Picks `limit` failed rows oldest-first and re-runs the real send path for
 * each (post, subscriber) pair. A pair that goes out gets failed_at cleared
 * and sent_at re-stamped; a pair that fails AGAIN keeps its failed_at, so the
 * next pass finds it in the same place. There is no attempt counter: the
 * ledger carries exactly one column (failed_at, db/migrations/0036) and a row
 * that keeps failing is a durable fact about an address, not a budget to
 * spend. `maxAttempts` therefore bounds THIS call — how many distinct pairs a
 * single pass may work through — and never hides a row from a later pass.
 *
 * `n` distinct (post, subscriber) pairs is `n` SMTP sessions (one per post,
 * batched per locale inside it), so a large limit against a dead server is a
 * slow pass. The caller's limit is the brake; the sweeper passes a small one.
 */
export async function retryFailedSends(maxAttempts = 3, limit = 200): Promise<RetryResult> {
  await ensureMigrations();
  const cap = Math.max(0, Math.trunc(maxAttempts));
  const max = Math.max(0, Math.trunc(limit));
  if (!cap || !max) return { retried: 0, succeeded: 0 };

  const failed = await db
    .select({ postId: newsletterSends.postId, subscriberId: newsletterSends.subscriberId })
    .from(newsletterSends)
    .where(isNotNull(newsletterSends.failedAt))
    // Oldest failure first: a row that has been waiting is the one most at
    // risk of never going out, and the newest ones are the ones the fanout
    // that just ran is still trying.
    .orderBy(asc(newsletterSends.failedAt))
    .limit(max);
  if (!failed.length) return { retried: 0, succeeded: 0 };

  // Group by post so one pass re-reads the post and the settings once per
  // article, not once per recipient.
  const byPost = new Map<number, number[]>();
  for (const row of failed) {
    const list = byPost.get(row.postId);
    if (list) list.push(row.subscriberId);
    else byPost.set(row.postId, [row.subscriberId]);
  }

  let retried = 0;
  let succeeded = 0;
  for (const [postId, subscriberIds] of byPost) {
    if (retried >= cap) break;
    const budget = cap - retried;
    // Conservative slicing: `budget` bounds the pairs this call works
    // through, and a post's whole failed batch is retried together (one
    // message per locale carries all of them anyway).
    if (subscriberIds.length > budget) {
      const slice = subscriberIds.slice(0, budget);
      retried += slice.length;
      const okIds = await resendBatch(postId, slice);
      succeeded += okIds.length;
      continue;
    }
    retried += subscriberIds.length;
    const okIds = await resendBatch(postId, subscriberIds);
    succeeded += okIds.length;
  }
  return { retried, succeeded };
}

/**
 * Re-send one post's failed batch. Returns the subscriber ids that went out
 * (failures keep their failed_at — the caller never clears them).
 */
async function resendBatch(postId: number, subscriberIds: number[]): Promise<number[]> {
  const [post] = await db
    .select({
      id: posts.id,
      title: posts.title,
      slug: posts.slug,
      publishedAt: posts.publishedAt,
      pinyinSlug: posts.pinyinSlug,
      initialSlug: posts.initialSlug,
      format: posts.format,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!post) return [];
  const audience = await db
    .select({ id: subscribers.id, email: subscribers.email, locale: subscribers.locale })
    .from(subscribers)
    .where(
      and(
        inArray(subscribers.id, subscriberIds),
        sql`${subscribers.confirmedAt} is not null`,
        isNull(subscribers.unsubscribedAt),
      ),
    );
  if (!audience.length) return [];
  const recipients = audience.map((r) => ({
    id: r.id,
    email: r.email,
    locale: r.locale === "en" ? "en" : DEFAULT_LOCALE,
  }));
  let okIds: number[];
  try {
    const { failedSubscriberIds } = await deliverPost(post, recipients);
    const failedSet = new Set(failedSubscriberIds);
    okIds = recipients.filter((r) => !failedSet.has(r.id)).map((r) => r.id);
  } catch (e) {
    log.warn("[newsletter] retry fanout failed:", e instanceof Error ? e.message : String(e));
    okIds = [];
  }
  if (okIds.length) await markDelivered(postId, okIds);
  return okIds;
}

/** Module-level throttle state: when the last retry pass ran. */
let lastRetryAt = 0;

/** How long the sweeper must wait between two retry passes. */
export const RETRY_THROTTLE_MS = 300_000;

/** Test seam: forget the retry throttle so a pass can run immediately. */
export function resetRetryThrottle(): void {
  lastRetryAt = 0;
}

/**
 * The sweeper's door into retryFailedSends: at most one retry pass per
 * RETRY_THROTTLE_MS.
 *
 * The tick runs every minute and a retry pass costs one SMTP session per
 * distinct post — against an SMTP server that is down, an unthrottled pass
 * would open that many sessions every single minute and hold them for their
 * full timeout. Five minutes keeps a genuinely failed delivery inside the
 * same news cycle without turning an outage into a load problem, and a row
 * that keeps failing is found again by every later pass (there is no attempt
 * counter to exhaust).
 *
 * `now` is injectable so the test can walk the clock without sleeping.
 */
export async function retryFailedSendsThrottled(now = Date.now(), maxAttempts = 3): Promise<RetryResult | null> {
  if (now - lastRetryAt < RETRY_THROTTLE_MS) return null;
  lastRetryAt = now;
  try {
    return await retryFailedSends(maxAttempts, 200);
  } catch (e) {
    log.warn("[newsletter] retry pass failed:", e instanceof Error ? e.message : String(e));
    return { retried: 0, succeeded: 0 };
  }
}

/**
 * One post to its (already claimed) recipients. Fire-and-forget by contract —
 * enqueueSweep does not await it, so a slow SMTP session never stalls the
 * sweeper's tick. SMTP unconfigured = silent skip (zero sends is the normal
 * state of an unconfigured site, not an error).
 *
 * Returns the subscriber ids whose mail did NOT go out (empty = success).
 *
 * The zh/en split is the attribution boundary: deliverPost sends ONE message
 * per locale with every recipient of that locale on it, so a rejected message
 * carries no per-address verdict — the failure set is the whole batch. That is
 * deliberately conservative: a retry that reaches an address which already got
 * the mail costs one duplicate, while a retry that never happens costs the
 * reader the article. The two batches are attributed independently, so an
 * English-only bounce never re-queues the Chinese recipients.
 */
async function deliverPost(
  post: DuePost,
  recipients: { id: number; email: string; locale: Locale }[],
): Promise<{ failedSubscriberIds: number[] }> {
  if (!(await smtpReady())) {
    log.debug("[newsletter] smtp not configured, skip post fanout");
    return { failedSubscriberIds: [] };
  }
  const notify = await getNotifySettings();
  const site = await getSettings();
  const siteName = String(site.siteTitle || "Oboext");
  const origin = configuredOrigin(process.env);
  const cfg = await getPermalinkConfig();

  const postUrl = `${origin}${postUrlFor(cfg, post as never)}`;
  const [zhSet, enSet] = splitByLocale(recipients);
  const failed: number[] = [];
  for (const [set, locale] of [
    [zhSet, "zh-CN"],
    [enSet, "en"],
  ] as const) {
    if (!set.length) continue;
    const t = makeT(locale);
    const subject = t("newsletter.mail_post_subject", { site: siteName, title: post.title });
    try {
      // sendTo's rejection propagates into `failed` here — it is NOT swallowed,
      // or the batch would silently count as delivered.
      await sendTo(notify, set.map((r) => r.email), subject, postUrl, t, siteName);
    } catch (e) {
      log.warn("[newsletter] post mail batch failed:", e instanceof Error ? e.message : String(e));
      failed.push(...set.map((r) => r.id));
    }
  }
  return { failedSubscriberIds: failed };
}

function splitByLocale<T extends { locale: Locale }>(rows: T[]): [T[], T[]] {
  const zh = rows.filter((r) => r.locale !== "en");
  const en = rows.filter((r) => r.locale === "en");
  return [zh, en];
}

async function sendTo(
  notify: Awaited<ReturnType<typeof getNotifySettings>>,
  to: string[],
  subject: string,
  postUrl: string,
  t: ReturnType<typeof makeT>,
  siteName: string,
): Promise<void> {
  const html =
    `<div style="padding:24px;font-family:system-ui,sans-serif">` +
    `<h2 style="margin:0 0 12px">${escapeHtml(siteName)}</h2>` +
    `<p>${t("newsletter.mail_post_lead")}</p>` +
    `<p><a href="${postUrl}">${escapeHtml(subject)}</a></p>` +
    `<p style="color:#888;font-size:12px">${t("newsletter.mail_foot")}</p>` +
    `</div>`;
  const text = `${subject}\n${postUrl}\n${t("newsletter.mail_foot")}`;
  await sendSmtpMail(
    {
      host: notify.smtp.host,
      port: notify.smtp.port,
      security: notify.smtp.security,
      user: notify.smtp.user,
      pass: notify.smtp.pass,
      from: notify.smtp.from || notify.smtp.user,
    },
    { to: to.join(","), subject, text, html },
  );
}

// re-export for the sweeper's type-free consumption
export type { DuePost };
