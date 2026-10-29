// Comment likes — counts are aggregated at query time (never stored on
// comments) so the number cannot drift.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db.js";
import { commentLikes } from "./schema";
import { ServiceError } from "./errors.js";

function requireVisitorKey(visitorKey: unknown): string {
  const key = typeof visitorKey === "string" ? visitorKey.trim() : "";
  if (!key) throw new ServiceError("缺少 visitor_key", 400);
  return key;
}

function requireCommentId(commentId: number): number {
  if (!Number.isInteger(commentId) || commentId <= 0) throw new ServiceError("参数错误", 422);
  return commentId;
}

export async function likeComment(
  _user: unknown | null,
  commentId: number,
  visitorKey: string,
): Promise<{ likes: number }> {
  const id = requireCommentId(commentId);
  const key = requireVisitorKey(visitorKey);
  // Idempotent upsert: a repeat like leaves the row (and the count) alone.
  await db.insert(commentLikes).values({ commentId: id, visitorKey: key }).onConflictDoNothing();
  const rows = await db
    .select({ id: commentLikes.id })
    .from(commentLikes)
    .where(eq(commentLikes.commentId, id));
  return { likes: rows.length };
}

export async function unlikeComment(
  _user: unknown | null,
  commentId: number,
  visitorKey: string,
): Promise<{ likes: number }> {
  const id = requireCommentId(commentId);
  const key = requireVisitorKey(visitorKey);
  await db
    .delete(commentLikes)
    .where(and(eq(commentLikes.commentId, id), eq(commentLikes.visitorKey, key)));
  const rows = await db
    .select({ id: commentLikes.id })
    .from(commentLikes)
    .where(eq(commentLikes.commentId, id));
  return { likes: rows.length };
}

/** One inArray query for a batch of comments; missing ids map to 0. */
export async function likesFor(commentIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!commentIds.length) return out;
  for (const id of commentIds) out.set(id, 0);
  const rows = await db
    .select({ commentId: commentLikes.commentId })
    .from(commentLikes)
    .where(inArray(commentLikes.commentId, commentIds));
  for (const row of rows) out.set(row.commentId, (out.get(row.commentId) ?? 0) + 1);
  return out;
}

/** Parse the batch GET ?ids=1,2,3 list: positive ints only, deduped, cap 200
 * (more than 200 valid ids is rejected, mirroring the API's 422). */
export function parseLikeIds(raw: string | null): number[] {
  const out: number[] = [];
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0 || out.indexOf(n) >= 0) continue;
    out.push(n);
    if (out.length > 200) throw new ServiceError("ids 上限 200", 422);
  }
  return out;
}
