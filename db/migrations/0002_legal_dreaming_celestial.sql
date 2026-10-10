CREATE TYPE "public"."post_format" AS ENUM('standard', 'aside', 'quote', 'link', 'image', 'gallery', 'video', 'audio', 'status');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "options" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plugins" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugins_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"area" text NOT NULL,
	"type" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"theme_slug" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_settings" ALTER COLUMN "site_title" SET DEFAULT 'oboext';--> statement-breakpoint
ALTER TABLE "site_settings" ALTER COLUMN "active_theme_slug" SET DEFAULT 'oboext-2026';--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "format" "post_format" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "format_meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "home_display" text DEFAULT 'latest' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "home_page_id" integer;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "posts_page_id" integer;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "posts_per_page" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "feed_items" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "feed_content" text DEFAULT 'excerpt' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "excerpt_length" integer DEFAULT 160 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "seo_title_template" text DEFAULT '%title% - %site%' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "seo_keywords" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "seo_default_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "seo_robots" text DEFAULT 'index,follow' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "og_image_url" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "twitter_card" text DEFAULT 'summary_large_image' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "twitter_site" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "verifications" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "custom_head" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "custom_footer" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "custom_css" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "analytics_id" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "icp_number" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "social_links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "timezone" text DEFAULT 'Asia/Shanghai' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "date_format" text DEFAULT 'YYYY-MM-DD' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "language" text DEFAULT 'zh-CN' NOT NULL;--> statement-breakpoint
ALTER TABLE "themes" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "options_key_idx" ON "options" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugins_slug_idx" ON "plugins" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widgets_area_idx" ON "widgets" USING btree ("theme_slug","area");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_pinned_idx" ON "posts" USING btree ("pinned");