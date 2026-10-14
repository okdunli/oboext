ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "tags" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_sort_idx" ON "media" ("sort_order");
