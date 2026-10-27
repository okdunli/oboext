


CREATE TABLE IF NOT EXISTS "page_metas" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL REFERENCES "pages"("id") ON DELETE cascade,
	"key" text NOT NULL,
	"value" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_metas_page_idx" ON "page_metas" ("page_id");
