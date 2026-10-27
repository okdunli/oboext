-- R272: the first stone of real per-locale content. posts gain a `locale`
-- column (the same "zh-CN"|"en" vocabulary the i18n catalog already speaks:
-- i18n.ts LOCALES). Everything shipped before this migration keeps its rows at
-- the default "zh-CN" via NOT NULL DEFAULT, so existing URLs, bookmarks and
-- smoke assertions are untouched — the column is DATA, not routing: nothing in
-- the render path reads it yet (R269's canonical merge stays). Pairing
-- (translation_of) and the admin UI are the next stones; this one only makes
-- the data exist so later rounds never need a second table rewrite.
ALTER TABLE "posts" ADD COLUMN "locale" text NOT NULL DEFAULT 'zh-CN';