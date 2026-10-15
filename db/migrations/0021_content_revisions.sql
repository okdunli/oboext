-- Content revision history (R27). One pre-update snapshot per save; the
-- composite (kind, target_id, id) index serves both the per-target listing
-- and the newest-first prune scan.
CREATE TABLE IF NOT EXISTS "content_revisions" (
  "id" serial PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "target_id" integer NOT NULL,
  "author_id" integer,
  "title" text NOT NULL,
  "excerpt" text,
  "content" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_revisions_target_idx" ON "content_revisions" ("kind", "target_id", "id");
