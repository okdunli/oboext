-- R255: traffic provenance for the visitor table, plus the daily rollup the
-- admin dashboard reads.
--
-- post_visitors already answers "was this (post, visitor) pair seen before"
-- (UNIQUE(post_id, visitor_key), 0015) and incrementViews() writes that INSERT
-- and the posts UPDATE in ONE statement (a CTE: the UPDATE reads `exists
-- (select 1 from ins)` to decide the unique_views increment). The provenance
-- columns therefore ride that same INSERT - never a second statement, or the
-- single round trip that comment protects is gone.
--
-- referrer_host stores the HOST ONLY. A full URL can carry a query string with
-- a person's search text or a session token, and the column is written for
-- every first visit, so the URL never reaches the database. referrer_kind is
-- the classification derived from that host (search/social/internal/direct/
-- other). Both are nullable: rows written before this migration have no
-- provenance, and a caller that passes no referrer keeps writing null.
--
-- visit_daily is the rollup the admin dashboard reads. It is NOT written on
-- the request path: the aggregation runs from the publish sweeper's minute
-- tick, and each pass upserts the ABSOLUTE aggregation of the last two days.
-- `views = excluded.views` (not `views + excluded.views`) is what makes a
-- rerun - or two instances sweeping the same minute - land on the same
-- numbers instead of doubling them. Re-reading yesterday on every pass closes
-- the midnight edge: a visit at 23:59:59 is only settled after the day flips.
--
-- Caveat, stated here because the column name promises more: post_visitors is
-- a FIRST-VISIT ledger (the INSERT is ON CONFLICT DO NOTHING, which is exactly
-- what keeps the UV dedup correct), so today `views` and `uniques` count the
-- same rows and are equal. views is the landing count, uniques the distinct
-- visitor count; the pair exists so a future per-visit source can fill views
-- without reshaping the dashboard payload.
ALTER TABLE "post_visitors" ADD COLUMN IF NOT EXISTS "referrer_host" text;--> statement-breakpoint
ALTER TABLE "post_visitors" ADD COLUMN IF NOT EXISTS "referrer_kind" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visit_daily" (
  "day" date NOT NULL,
  "post_id" integer NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "referrer_kind" text NOT NULL,
  "views" integer NOT NULL DEFAULT 0,
  "uniques" integer NOT NULL DEFAULT 0,
  CONSTRAINT "visit_daily_day_post_kind_pk" PRIMARY KEY ("day", "post_id", "referrer_kind")
);
--> statement-breakpoint
-- The rollup's predicate is `created_at >= current_date - 1`, which neither the
-- (post_id, visitor_key) unique index nor the primary key of visit_daily can
-- answer. Without this index every minute tick scans the whole ledger, which
-- grows without bound (nothing prunes post_visitors). The index is one btree
-- entry per first visit, so the write path pays ~nothing on top of the INSERT
-- it already does.
CREATE INDEX IF NOT EXISTS "post_visitors_created_idx" ON "post_visitors" ("created_at");
