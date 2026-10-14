-- Query-shaped indexes for the ORDER BYs listPosts() issues.
--
-- Measured against the live database before applying (tools/index-check.mts,
-- EXPLAIN without ANALYZE so nothing was executed). What was actually found:
--
--   post_categories   2260 rows   Bitmap Index Scan on post_categories_pk
--                               Index Cond: (category_id = ANY('{...}'))
--   post_tags         2260 rows   same, on post_tags_pk
--
-- i.e. the category_id / tag_id sibling lookups in queries.ts (~513) are
-- ALREADY served by the existing composite primary keys. An earlier draft of
-- this migration claimed otherwise — the reasoning was "a composite index is
-- only usable from its leading column", which is true of an ordered index
-- scan but not of a bitmap scan built from an equality/ANY condition on any
-- column. That claim was checked against EXPLAIN before being acted on and
-- was wrong; no index is added for those tables here.
--
-- What remains is the posts ORDER BY. Today the planner picks
--   Limit -> Sort (Sort Key: published_at DESC) -> Seq Scan on posts
-- with a total cost around 2.7, because the table is small enough that
-- scanning it beats any index walk. So these indexes are NOT a fix for a
-- measured problem — they are insurance for growth, and adding them now is
-- the cheap way to have them when the table is large enough to need them.
--
-- Caveat worth stating: CREATE INDEX takes a SHARE lock, blocking writes to
-- the table for the duration. That is a sub-second build at this size and a
-- real maintenance window on a large one — so re-check the table size before
-- running this against a database that has grown a lot since.
--
-- Two single-column filter indexes already exist (posts_status_idx,
-- posts_pinned_idx); neither helps an ORDER BY. Composite, status first,
-- because every listing filters on status and then sorts — the reverse column
-- order would not be usable for that plan.
--
-- published_at goes in as the second column because every one of these sorts
-- has it as the tiebreaker, and a half-covered sort still leaves the planner a
-- Sort node to do.
--
-- NOT UNIQUE: published_at is nullable (legacy rows have NULL and queries.ts
-- keeps them visible), and Postgres treats NULLs as distinct in a unique
-- index, so two NULL rows would not collide anyway — it would cost an index
-- write per insert to enforce nothing.
CREATE INDEX IF NOT EXISTS "posts_status_published_idx" ON "posts" ("status", "published_at" DESC);

-- listPosts({ orderBy: "views" | "likes" | "comments" }) (queries.ts ~308-313).
-- Same reasoning: a filter-only index does nothing for an ORDER BY.
CREATE INDEX IF NOT EXISTS "posts_views_idx" ON "posts" ("views" DESC, "published_at" DESC);
CREATE INDEX IF NOT EXISTS "posts_likes_idx" ON "posts" ("likes" DESC, "published_at" DESC);
CREATE INDEX IF NOT EXISTS "posts_comments_idx" ON "posts" ("comments_count" DESC, "published_at" DESC);
