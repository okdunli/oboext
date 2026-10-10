-- M2 front-end member registration: nicknames must be unique (they double as
-- login identifiers), and email becomes optional — members register with a
-- nickname + password and log in by nickname. Postgres unique indexes treat
-- NULLs as distinct, so existing unique(email) still allows many email-less
-- accounts.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_name_idx" ON "users" ("name");
