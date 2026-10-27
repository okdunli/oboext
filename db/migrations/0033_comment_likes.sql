-- Comment likes: one row per (comment, visitor). Counts are aggregated at
-- query time (comment-likes.ts) — nothing is stored on comments.
CREATE TABLE IF NOT EXISTS "comment_likes" (
  "id" serial PRIMARY KEY,
  "comment_id" integer NOT NULL REFERENCES "comments"("id") ON DELETE CASCADE,
  "visitor_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "comment_likes_comment_visitor_pk" UNIQUE ("comment_id", "visitor_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comment_likes_comment_idx" ON "comment_likes" ("comment_id");
--> statement-breakpoint
