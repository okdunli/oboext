ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "footer_links" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
