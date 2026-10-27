-- Search-term telemetry for the admin hot-terms screen (/admin/search-terms).
--
-- One row per (term, locale): recordSearchTerm (search-terms.ts) upserts with
-- ON CONFLICT DO UPDATE SET hits = hits + 1, last_at = now(). Writes are
-- fire-and-forget from the public search loader, so the table is a best-effort
-- counter, not a transactional record - a lost increment costs nothing.
--
-- Operational target: terms that return ZERO results (content gaps) and terms
-- that accumulate hits (what readers actually want). hits/last_at carry the
-- ranking; the admin page orders by (hits DESC, last_at DESC), which the
-- composite index below serves directly (backward scan of an ASC twin, or the
-- DESC columns as declared - both are equivalent to the planner).
CREATE TABLE IF NOT EXISTS "search_terms" (
  "id" serial PRIMARY KEY,
  "term" text NOT NULL,
  "locale" text NOT NULL DEFAULT 'zh-CN',
  "hits" integer NOT NULL DEFAULT 1,
  "last_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "search_terms_term_locale_pk" UNIQUE ("term", "locale")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_terms_hits_last_idx" ON "search_terms" ("hits" DESC, "last_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_terms_last_at_idx" ON "search_terms" ("last_at" DESC);
