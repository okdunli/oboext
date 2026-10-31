-- The publish sweeper filters pages on (status, published_at) once a minute.
-- Without a matching index it rode pages_status_idx and filtered published_at
-- in the index (2.3 ms at 5k pages, measured R? — see publish-sweeper.ts); this
-- brings pages in line with posts_status_published_idx (0018).
CREATE INDEX IF NOT EXISTS "pages_status_published_idx" ON "pages" ("status","published_at");
