-- Passwordless flag moves from the shared oauth.nopassword option array to a
-- per-user column, so the mark is an atomic single-row UPDATE (the array was a
-- read-modify-write that lost ids under concurrency -> locked-out users).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordless" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill: every id currently in the oauth.nopassword array becomes passwordless.
-- jsonb_typeof guard keeps a missing/non-array option a safe no-op.
UPDATE "users" u
SET "passwordless" = true
WHERE u.id IN (
  SELECT (jsonb_array_elements_text(o.value))::int
  FROM "options" o
  WHERE o.key = 'oauth.nopassword'
    AND jsonb_typeof(o.value) = 'array'
);
--> statement-breakpoint
-- The array is now dead (reads/writes go through the column); drop it so no
-- stale copy can diverge.
DELETE FROM "options" WHERE "key" = 'oauth.nopassword';
