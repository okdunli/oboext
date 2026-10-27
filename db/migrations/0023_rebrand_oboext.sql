-- Rebrand identifiers: Exoboe -> Oboext. Same shape as 0022, one generation on:
-- the column default that carries the product name and the plugin/theme rows.
ALTER TABLE "site_settings" ALTER COLUMN "site_title" SET DEFAULT 'Oboext';
--> statement-breakpoint
UPDATE "plugins" SET "author" = 'Oboext' WHERE "author" IN ('Exoboe', 'exoboe');
--> statement-breakpoint
UPDATE "plugins" SET "slug" = 'hello-oboext', "name" = 'Hello Oboext' WHERE "slug" = 'hello-exoboe';
--> statement-breakpoint
UPDATE "themes" SET "name" = 'Oboext Default' WHERE "slug" = 'default' AND "name" = 'Exoboe Default';
