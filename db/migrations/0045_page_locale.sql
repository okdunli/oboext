-- The same stone posts got in 0042, for the OTHER content table: pages gain
-- a `locale` column (the i18n catalog's "zh-CN"|"en" vocabulary). Without it a
-- page could not say which language it is written in, so the /en tree listed
-- Chinese page titles in its feed and the sitemap offered one page twice.
-- Existing rows keep "zh-CN" via NOT NULL DEFAULT, so every current URL,
-- bookmark and smoke assertion is untouched.
ALTER TABLE "pages" ADD COLUMN "locale" text NOT NULL DEFAULT 'zh-CN';
