-- M1 user-identity foundation: phone + ban flag + verification state on
-- users, per-entry SEO keywords, third-party OAuth identities and hashed
-- email/SMS verification codes.
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text NOT NULL DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
-- Postgres unique indexes allow multiple NULLs, so users without a phone
-- coexist freely.
CREATE UNIQUE INDEX "users_phone_idx" ON "users" ("phone");--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "seo_keywords" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "seo_keywords" text;--> statement-breakpoint
CREATE TABLE "oauth_identities" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "provider" text NOT NULL,
  "open_id" text NOT NULL,
  "nickname" text,
  "avatar_url" text,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_login_at" timestamp with time zone,
  CONSTRAINT "oauth_identities_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_identities_provider_open_idx" ON "oauth_identities" ("provider","open_id");--> statement-breakpoint
CREATE INDEX "oauth_identities_user_idx" ON "oauth_identities" ("user_id");--> statement-breakpoint
CREATE TABLE "verify_codes" (
  "id" serial PRIMARY KEY NOT NULL,
  "target" text NOT NULL,
  "channel" text NOT NULL,
  "purpose" text NOT NULL,
  "code_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "ip" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "verify_codes_target_idx" ON "verify_codes" ("target","purpose");--> statement-breakpoint
