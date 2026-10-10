-- 0003: comment provider switch (builtin / Artalk / Giscus / Waline / Twikoo / Disqus / Utterances)
--        + avatar source for built-in comments.
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "comment_provider" text NOT NULL DEFAULT 'builtin';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "artalk_server" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "artalk_site" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "giscus_repo" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "giscus_repo_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "giscus_category" text NOT NULL DEFAULT 'General';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "giscus_category_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "giscus_mapping" text NOT NULL DEFAULT 'pathname';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "giscus_reactions" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "giscus_theme" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "waline_server" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "twikoo_env_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "disqus_shortname" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "utterances_repo" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "utterances_term" text NOT NULL DEFAULT 'pathname';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "avatar_source" text NOT NULL DEFAULT 'gravatar';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "avatar_size" integer NOT NULL DEFAULT 80;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "avatar_default" text NOT NULL DEFAULT 'identicon';--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "avatar_rating" text NOT NULL DEFAULT 'g';
