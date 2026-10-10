CREATE TYPE "public"."comment_state" AS ENUM('published', 'pending', 'spam');--> statement-breakpoint
CREATE TYPE "public"."comment_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"post_type" text DEFAULT 'post' NOT NULL,
	"parent_id" integer,
	"user_id" integer,
	"author_name" text NOT NULL,
	"author_email" text,
	"author_url" text,
	"content" text NOT NULL,
	"status" "comment_state" DEFAULT 'pending' NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menu_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"menu_id" integer NOT NULL,
	"parent_id" integer,
	"order" integer DEFAULT 0 NOT NULL,
	"type" text DEFAULT 'custom' NOT NULL,
	"label" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"reference_id" integer,
	"reference_slug" text,
	"target" text DEFAULT '_self' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menus" (
	"id" serial PRIMARY KEY NOT NULL,
	"location" text NOT NULL,
	"name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menus_location_unique" UNIQUE("location")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "post_metas" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"key" text NOT NULL,
	"value" text
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "comment_status" "comment_status" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "comments_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "views" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "comment_status" "comment_status" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "comments_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "views" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "comments_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "require_name_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "comment_moderation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "comment_moderation_words" text DEFAULT '' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_metas" ADD CONSTRAINT "post_metas_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_post_idx" ON "comments" USING btree ("post_id","post_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_status_idx" ON "comments" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_items_menu_idx" ON "menu_items" USING btree ("menu_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "post_metas_post_idx" ON "post_metas" USING btree ("post_id");