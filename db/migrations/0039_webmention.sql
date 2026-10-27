-- Webmention (W3C REC) — inbound mention ledger.
--
-- One row per (source, target) pair the receiver has been told about. The row
-- is claimed BEFORE any network work (INSERT ... ON CONFLICT DO NOTHING), so
-- the unique constraint is what makes a re-sent mention idempotent: the second
-- delivery finds the row already there and does nothing. status walks
-- pending -> accepted (comment created) or pending -> rejected (fetch failed,
-- source does not link to the target, target is not a published post, ...).
--
-- comment_id has no FK on purpose: comments are hard-deleted from the admin
-- (deleteComment), and a moderation decision must not erase the record that
-- the mention itself arrived. A dangling id reads as "the comment is gone".
--
-- post_id is nullable because a mention can arrive for a URL that is not (or
-- no longer) a published post — the row is still worth keeping, as evidence
-- the endpoint was probed and to keep the dedupe key occupied.
CREATE TABLE IF NOT EXISTS "webmentions" (
  "id" serial PRIMARY KEY,
  "source" text NOT NULL,
  "target" text NOT NULL,
  "post_id" integer REFERENCES "posts"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending',
  "comment_id" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "webmentions_source_target_pk" UNIQUE ("source", "target")
);
--> statement-breakpoint
-- Serves "mentions for this post" (an index walk instead of a seq scan on a
-- table that only ever grows); the unique key above already covers dedupe.
CREATE INDEX IF NOT EXISTS "webmentions_post_idx" ON "webmentions" ("post_id");
