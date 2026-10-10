-- M2 configurable permalinks: persisted pinyin / pinyin-initials link tails.
-- URL generation derives the tail from the post title, so reversing a URL
-- back to a post cannot re-run the (non-injective) transliteration; instead
-- the unique tails are stored and populated at write time. Postgres allows
-- multiple NULLs, so pre-existing rows coexist until the lazy backfill runs.
ALTER TABLE "posts" ADD COLUMN "pinyin_slug" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "initial_slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_pinyin_slug_idx" ON "posts" ("pinyin_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_initial_slug_idx" ON "posts" ("initial_slug");
