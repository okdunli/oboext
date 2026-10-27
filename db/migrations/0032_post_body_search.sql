-- R200: full-text search over the article BODY, not just title/excerpt/
-- taxonomy. Before this, typing a phrase that appears only in a post's body
-- returned zero results — the search box answered a different question than the
-- reader asked. The jsonb `content` body is the render/export source of truth;
-- a plain-text projection `body_plain` is the SEARCHABLE form.
--
-- Why a plain text column and not a generated tsvector / to_tsvector on the
-- jsonb: no trigram or zhparser extension ships with the bundled PGlite, and
-- the project's search is already an ILIKE term match (CJK-safe: ILIKE %term%
-- finds a substring, so unspaced Chinese just works). Adding body_plain lets us
-- fold the body into the SAME ILIKE term-matching the title/excerpt already use,
-- zero new query machinery, zero extension dependency. The column is maintained
-- on every post write (createPost/updatePost) and back-filled here for rows
-- already in the database.
--
-- The backfill is idempotent: columns keep NULL until a post is next saved, and
-- the search WHERE treats NULL as a non-match (correct — a row with no body
-- text should not match a body term). The body term match reuses the SAME
-- plain ILIKE the title/excerpt already use, so there is no substring index for
-- it (none exists for those columns either); a row with a populated body_plain
-- is matched exactly as a populated title is. The projection mirrors
-- blocksToPlainText in oboext/src/server/render.ts
-- (heading/paragraph/quote/code/list/image caption).

ALTER TABLE posts ADD COLUMN IF NOT EXISTS body_plain text;
--> statement-breakpoint

ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_plain text;
