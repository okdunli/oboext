-- Rebrand identifiers: xoboe -> Exoboe. Repairs the column defaults that
-- still carry the pre-rebrand product name and the plugin/theme display rows.
ALTER TABLE "site_settings" ALTER COLUMN "site_title" SET DEFAULT 'Exoboe';
--> statement-breakpoint
ALTER TABLE "site_settings" ALTER COLUMN "active_theme_slug" SET DEFAULT 'default';
--> statement-breakpoint
UPDATE "plugins" SET "author" = 'Exoboe' WHERE "author" IN ('Xoboe', 'xoboe');
--> statement-breakpoint
UPDATE "plugins" SET "slug" = 'hello-exoboe', "name" = 'Hello Exoboe' WHERE "slug" = 'hello-xoboe';
--> statement-breakpoint
UPDATE "themes" SET "name" = 'Exoboe Default' WHERE "slug" = 'default' AND "name" = 'xoboe Default';
