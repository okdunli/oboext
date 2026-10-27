-- R248: search acceleration. The 0032 comment said "no trigram extension ships
-- with the bundled PGlite" — that premise expired: PGlite 0.2.17 bundles
-- pg_trgm (dist/pg_trgm.tar.gz), and R248 wires it into pgliteOptions(). These
-- indexes turn the 22 ILIKE sites (title/excerpt/body_plain + taxonomy names)
-- into Bitmap Index Scans without changing a single query.
--
-- Why trigram and not tsvector for the main match: ILIKE '%term%' is
-- CJK-safe by construction (a substring IS the match for unspaced Chinese),
-- and gin_trgm_ops serves exactly that. tsvector's value is English/latin
-- relevance ranking (ts_rank), which is a separate later step — it cannot
-- serve CJK at all until a real tokenizer exists.
--
-- Guarded on purpose: on a driver without pg_trgm (older PGlite, Neon without
-- the extension) every statement below is a no-op and the system keeps the
-- exact pre-0034 behaviour — plain ILIKE, seq scans. The queries never
-- reference the indexes by name, so nothing breaks.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "posts_title_trgm_idx" ON "posts" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_excerpt_trgm_idx" ON "posts" USING gin ("excerpt" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_body_plain_trgm_idx" ON "posts" USING gin ("body_plain" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_body_plain_trgm_idx" ON "pages" USING gin ("body_plain" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_name_trgm_idx" ON "categories" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tags_name_trgm_idx" ON "tags" USING gin ("name" gin_trgm_ops);
