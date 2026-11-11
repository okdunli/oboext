// Author notification for comments — the `commentCreated` consumer and the
// moderation-approval twin. Fire-and-forget by contract: a mail failure (or
// an unconfigured SMTP, the normal fresh-install state) must never touch the
// comment flow, so every entry point voids with a catch.
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { comments, posts, users } from "./schema.js";
import { addAction, HOOKS } from "./hooks.js";
import { getNotifySettings } from "./notify.js";
import { sendSmtpMail } from "./smtp.js";
import { getSettings } from "./queries.js";
import { getPermalinkConfig, postUrlFor } from "./links.js";
import { configuredOrigin } from "./site-origin.js";
import { getOptionFresh, setOption } from "./options.js";
import { getSecret } from "./auth.js";
import crypto from "node:crypto";
import { DEFAULT_LOCALE, makeT } from "./i18n.js";
import { createLogger } from "./logger.js";

const log = createLogger("comment-notify");

// A single-flight mail queue: bulk-approving hundreds of comments used to
// start one concurrent SMTP session per mail (fire-and-forget promises all
// launch together). Mails go out one at a time, in order; a slow server
// delays the queue instead of tripping its connection cap.
let mailQueue: Promise<void> = Promise.resolve();
function enqueueMail(job: () => Promise<void>): void {
  const run = mailQueue.then(job);
  mailQueue = run.catch(() => {});
}

const EXCERPT_LEN = 200;

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

/** Mail the post author about a visible comment. Silent no-op when the post
 *  has no author with an email, when the commenter IS the author, or when
 *  SMTP is not configured. The post row (title included) is looked up here so
 *  every caller hands over only what the comment event already carries. */
async function notifyAuthor(comment: {
  id: number;
  authorName: string;
  authorEmail?: string | null;
  content: string;
}, postType: string, postId: number): Promise<void> {
  try {
    if (postType !== "post") return; // pages have no author to notify
    const notify = await getNotifySettings();
    if (!notify.smtp.host) return;
    const [post] = await db
      .select({ authorId: posts.authorId, slug: posts.slug, title: posts.title })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    if (!post?.authorId) return;
    const postTitle = post.title || "";
    const [author] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, post.authorId))
      .limit(1);
    if (!author?.email) return;
    if (comment.authorEmail && comment.authorEmail.toLowerCase() === author.email.toLowerCase()) return;

    // Two independent reads: issue them together — one round trip per
    // notification instead of two.
    const [cfg, site] = await Promise.all([getPermalinkConfig(), getSettings()]);
    const locale = (String(site.language || DEFAULT_LOCALE) === "en" ? "en" : "zh-CN") as "en" | "zh-CN";
    const t = makeT(locale);
    const origin = configuredOrigin(process.env);
    const url = `${origin}${postUrlFor(cfg, { id: postId, slug: post.slug })}#comment-item-${comment.id}`;
    const excerpt = String(comment.content || "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_LEN);

    const subject = t("notify.comment_subject", { site: String(site.siteTitle || "Oboext"), title: postTitle });
    const text =
      `${t("notify.comment_lead", { name: comment.authorName, title: postTitle })}\n\n` +
      `${excerpt}\n\n${url}`;
    const html =
      `<div style="padding:24px;font-family:system-ui,sans-serif">` +
      `<h2 style="margin:0 0 12px">${escapeHtml(String(site.siteTitle || "Oboext"))}</h2>` +
      `<p>${escapeHtml(t("notify.comment_lead", { name: comment.authorName, title: postTitle }))}</p>` +
      `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #ddd;color:#555">${escapeHtml(excerpt)}</blockquote>` +
      `<p><a href="${escapeHtml(url)}">${escapeHtml(t("notify.comment_cta"))}</a></p>` +
      `<p style="color:#888;font-size:12px">${escapeHtml(t("notify.comment_foot"))}</p>` +
      `</div>`;

    await sendSmtpMail(
      {
        host: notify.smtp.host,
        port: notify.smtp.port,
        security: notify.smtp.security,
        user: notify.smtp.user,
        pass: notify.smtp.pass,
        from: notify.smtp.from || notify.smtp.user,
      },
      { to: author.email, subject, text, html },
    );
  } catch (e) {
    log.warn("author notify failed:", e);
  }
}

/** A direct reply to a reader'"'"'s comment is worth a mail to THAT reader —
 *  the post-author mail above never reaches them. Silent no-op when the parent
 *  comment left no email, when the reply comes from the same address, or when
 *  SMTP is not configured. */
// Reply-mail opt-out: the mail carries a signed one-click link, and a reader
// who used it never gets another reply mail. The key is the SHA-256 of the
// address (never the raw address), the token is an HMAC over it with the
// session secret - a third party cannot forge an unsubscribe for someone else.
export function unsubKey(email: string): string {
  return "comment-unsub:" + crypto.createHash("sha256").update(email.toLowerCase()).digest("hex");
}

export function commentUnsubToken(email: string): string {
  return crypto.createHmac("sha256", getSecret()).update(email.toLowerCase()).digest("hex").slice(0, 32);
}

async function replyMailAllowed(email: string): Promise<boolean> {
  return !(await getOptionFresh(unsubKey(email), false));
}

async function notifyParentOfReply(comment: {
  parentId?: number | null;
  authorName: string;
  authorEmail?: string | null;
  content: string;
}, postType: string, postId: number): Promise<void> {
  try {
    // Page comments have no posts row to link to (postId is a pages.id here);
    // reply mail is a post-only feature, same boundary notifyAuthor draws.
    if (postType !== "post") return;
    if (!comment.parentId) return;
    const notify = await getNotifySettings();
    if (!notify.smtp.host) return;
    // Only a VISIBLE parent comment earns a mail: a reply to a pending or
    // spam row would notify someone whose comment the site never published.
    const [parent] = await db
      .select({ authorName: comments.authorName, authorEmail: comments.authorEmail, status: comments.status })
      .from(comments)
      .where(eq(comments.id, comment.parentId))
      .limit(1);
    if (!parent || parent.status !== "published") return;
    if (!parent.authorEmail) return;
    if (
      comment.authorEmail &&
      comment.authorEmail.toLowerCase() === parent.authorEmail.toLowerCase()
    )
      return;
    if (!(await replyMailAllowed(parent.authorEmail))) {
      log.debug("[comment-notify] reader opted out of reply mail");
      return;
    }
    const [post] = await db
      .select({ slug: posts.slug, title: posts.title, authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    if (!post) return;
    // The post author already hears about this comment through the author
    // notification - the reply mail would be a second mail for one event.
    if (post.authorId) {
      const [pAuthor] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, post.authorId))
        .limit(1);
      if (
        pAuthor?.email &&
        parent.authorEmail.toLowerCase() === pAuthor.email.toLowerCase()
      )
        return;
    }
    // Two independent reads: issue them together — one round trip per
    // notification instead of two.
    const [cfg, site] = await Promise.all([getPermalinkConfig(), getSettings()]);
    const locale = (String(site.language || DEFAULT_LOCALE) === "en" ? "en" : "zh-CN") as "en" | "zh-CN";
    const t = makeT(locale);
    const origin = configuredOrigin(process.env);
    const url =
      `${origin}${postUrlFor(cfg, { id: postId, slug: post.slug })}#comment-item-${comment.parentId}`;
    const excerpt = String(comment.content || "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_LEN);
    const subject = t("notify.reply_subject", { site: String(site.siteTitle || "Oboext") });
    const unsub =
      `${origin}/api/comments/unsubscribe?email=${encodeURIComponent(parent.authorEmail)}` +
      `&token=${commentUnsubToken(parent.authorEmail)}`;
    const text =
      `${t("notify.reply_lead", { name: comment.authorName })}\n\n` +
      `${excerpt}\n\n${url}\n\n${t("notify.reply_unsub")}: ${unsub}`;
    const html =
      `<div style="padding:24px;font-family:system-ui,sans-serif">` +
      `<h2 style="margin:0 0 12px">${escapeHtml(String(site.siteTitle || "Oboext"))}</h2>` +
      `<p>${escapeHtml(t("notify.reply_lead", { name: comment.authorName }))}</p>` +
      `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #ddd;color:#555">${escapeHtml(excerpt)}</blockquote>` +
      `<p><a href="${escapeHtml(url)}">${escapeHtml(t("notify.reply_cta"))}</a></p>` +
      `<p style="color:#888;font-size:12px"><a href="${escapeHtml(unsub)}">${escapeHtml(t("notify.reply_unsub"))}</a> · ${escapeHtml(t("notify.comment_foot"))}</p>` +
      `</div>`;
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
        to: parent.authorEmail,
        subject,
        text,
        html,
        listUnsubscribe: unsub,
      },
    );
  } catch (e) {
    log.warn("reply notify failed:", e);
  }
}

/** One registration per process; idempotent like registerWebmentionHooks. */
let registered = false;
export function registerCommentNotify(): void {
  if (registered) return;
  registered = true;
  addAction(HOOKS.commentCreated, ({ comment, postType, postId, isPublic }) => {
    // Pending comments notify when the moderation verdict approves them (the
    // update path calls notifyCommentVisible), not at submission time.
    if (isPublic) {
      enqueueMail(() => notifyAuthor(comment, postType, postId));
      enqueueMail(() => notifyParentOfReply(comment, postType, postId));
    }
    return Promise.resolve();
  });
}

/** The moderation twin: a comment that just became visible through the admin
 *  approve path (single or bulk). Fire-and-forget. */
export function notifyCommentVisible(
  comment: {
    id: number;
    parentId?: number | null;
    authorName: string;
    authorEmail?: string | null;
    content: string;
  },
  postType: string,
  postId: number,
): void {
  enqueueMail(() => notifyAuthor(comment, postType, postId));
  enqueueMail(() => notifyParentOfReply(comment, postType, postId));
}
