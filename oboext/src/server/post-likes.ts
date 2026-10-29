// Post likes — one row per (post, visitor) (db/migrations/0040), the same
// shape comment-likes.ts uses for comment likes. `posts.likes` stays the
// denormalized counter the admin lists and rankings order by; this table is
// what makes the increment idempotent and the like undoable.
//
// Every write below is ONE statement: the row INSERT/DELETE rides a CTE and
// the counter UPDATE runs only when that statement's CTE really touched a row
// (ON CONFLICT DO NOTHING / DELETE ... RETURNING yield an empty CTE for a
// repeat). This is incrementViews' post_visitors pattern with a like in place
// of a view — a read-then-write would let two concurrent likes from the same
// visitor both see "not liked yet" and both add one to posts.likes.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db.js";
import { posts, postLikes } from "./schema.js";
import { ServiceError } from "./errors.js";

/** Cookie carrying the visitor identity (shared with /api/comment-like). */
const COOKIE = "visitor_key";

function requireVisitorKey(visitorKey: unknown): string {
  const key = typeof visitorKey === "string" ? visitorKey.trim() : "";
  if (!key) throw new ServiceError("缺少 visitor_key", 400);
  return key;
}

function requirePostId(postId: unknown): number {
  if (!Number.isInteger(postId) || (postId as number) <= 0)
    throw new ServiceError("参数错误", 422);
  return postId as number;
}

/** The CTE statements answer found/liked/likes in one round trip. */
type WriteRow = {
  found: boolean;
  liked?: boolean;
  removed?: boolean;
  likes: number | string | null;
};

function writeRows(res: unknown): WriteRow[] {
  if (Array.isArray(res)) return res as WriteRow[];
  return ((res as { rows?: WriteRow[] }).rows ?? []);
}

/**
 * Like a post for one visitor. Idempotent: a repeat like from the same key
 * leaves both the row and the counter alone and still reports the current
 * state. 404 when the post itself is gone.
 */
export async function likePost(
  postId: number,
  visitorKey: string,
): Promise<{ liked: boolean; likes: number }> {
  const id = requirePostId(postId);
  const key = requireVisitorKey(visitorKey);
  const rows = writeRows(
    await db.execute(sql`
      with ins as (
        insert into ${postLikes} ("post_id", "visitor_key")
        select ${id}::int, ${key}::text
        where exists (select 1 from ${posts} where "id" = ${id})
        on conflict do nothing
        returning "post_id"
      ),
      upd as (
        update ${posts}
        set "likes" = "likes" + 1
        where "id" = ${id} and exists (select 1 from ins)
        returning "likes"
      )
      select
        exists (select 1 from ${posts} where "id" = ${id}) as "found",
        -- "liked" is the visitor's state AFTER this call, not "did I insert":
        -- the ins CTE covers the first like, and the plain read covers a repeat
        -- (a data-modifying CTE's own effects are invisible to the rest of the
        -- statement, so both sides are needed to read either outcome).
        (exists (select 1 from ins)
          or exists (select 1 from ${postLikes}
                      where "post_id" = ${id} and "visitor_key" = ${key})) as "liked",
        coalesce(
          (select "likes" from upd),
          (select "likes" from ${posts} where "id" = ${id})
        ) as "likes"`),
  );
  const row = rows[0];
  if (!row || !row.found) throw new ServiceError("文章不存在", 404);
  return { liked: !!row.liked, likes: Number(row.likes ?? 0) };
}

/**
 * Undo this visitor's like. Only a row this statement actually deleted
 * decrements the counter, so unliking twice (or unliking something never
 * liked) changes nothing. Always reports liked: false.
 */
export async function unlikePost(
  postId: number,
  visitorKey: string,
): Promise<{ liked: boolean; likes: number }> {
  const id = requirePostId(postId);
  const key = requireVisitorKey(visitorKey);
  const rows = writeRows(
    await db.execute(sql`
      with del as (
        delete from ${postLikes}
        where "post_id" = ${id} and "visitor_key" = ${key}
        returning "post_id"
      ),
      upd as (
        update ${posts}
        set "likes" = "likes" - 1
        where "id" = ${id} and exists (select 1 from del)
        returning "likes"
      )
      select
        exists (select 1 from ${posts} where "id" = ${id}) as "found",
        exists (select 1 from del) as "removed",
        coalesce(
          (select "likes" from upd),
          (select "likes" from ${posts} where "id" = ${id})
        ) as "likes"`),
  );
  const row = rows[0];
  if (!row || !row.found) throw new ServiceError("文章不存在", 404);
  return { liked: false, likes: Number(row.likes ?? 0) };
}

/**
 * Which of `postIds` this visitor has liked — ONE inArray query for the whole
 * page (the list/detail backfill; never N+1). Ids not in the set are simply
 * not liked, and an empty input or empty key answers without a query.
 */
export async function likesFor(visitorKey: string, postIds: number[]): Promise<Set<number>> {
  const key = requireVisitorKey(visitorKey);
  const out = new Set<number>();
  const ids = [...new Set(postIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return out;
  const rows = await db
    .select({ postId: postLikes.postId })
    .from(postLikes)
    .where(and(eq(postLikes.visitorKey, key), inArray(postLikes.postId, ids)));
  for (const row of rows) out.add(row.postId);
  return out;
}

/**
 * `likesFor` for a render path: a request with no visitor identity (no
 * visitor_key cookie yet) has nothing to backfill, so it answers an empty set
 * instead of querying or throwing.
 */
export async function likedPostsFor(
  visitorKey: string | null | undefined,
  postIds: number[],
): Promise<Set<number>> {
  if (!visitorKey || !postIds.length) return new Set<number>();
  return likesFor(visitorKey, postIds);
}

/**
 * The visitor key off a raw `cookie` request header — same parse as
 * /api/comment-like's getCookie (decode, first match, trimmed). Render paths
 * only ever READ the identity here; minting it is the API's job.
 */
export function visitorKeyFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k !== COOKIE) continue;
    const value = decodeURIComponent(rest.join("=")).trim();
    if (value) return value;
  }
  return null;
}
