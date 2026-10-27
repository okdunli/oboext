-- Post likes: one row per (post, visitor) so a like can be deduped and undone.
--
-- The old like was an unconditional `UPDATE posts SET likes = likes + 1` with
-- the "have I liked this" flag kept in localStorage - any second browser (or a
-- scripted loop) could farm the counter. This table is the same shape as
-- comment_likes (0033) and post_visitors (incrementViews' UNIQUE dedupe):
-- UNIQUE(post_id, visitor_key) makes the INSERT idempotent, so post-likes.ts
-- can tie the counter increment to "this statement actually inserted a row"
-- in ONE statement (CTE), with no read-then-write window for a race.
CREATE TABLE IF NOT EXISTS "post_likes" (
  "id" serial PRIMARY KEY,
  "post_id" integer NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "visitor_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "post_likes_post_visitor_pk" UNIQUE ("post_id", "visitor_key")
);
--> statement-breakpoint
-- Serves the per-post count/admin reads (also reachable through the UNIQUE's
-- leading column).
CREATE INDEX IF NOT EXISTS "post_likes_post_idx" ON "post_likes" ("post_id");
--> statement-breakpoint
-- Serves the list/detail backfill: one `visitor_key = ? AND post_id = ANY(?)`
-- batch read for every id on the page.
CREATE INDEX IF NOT EXISTS "post_likes_visitor_idx" ON "post_likes" ("visitor_key");
--> statement-breakpoint
