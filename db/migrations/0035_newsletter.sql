-- Newsletter subscribers + per-(post, subscriber) send ledger.
--
-- subscribers: one row per email. state is the pair (confirmed_at,
-- unsubscribed_at), both nullable timestamps rather than an enum so a
-- re-subscribe is an UPDATE on an existing row and the UNIQUE(email) invariant
-- holds across confirm/unsubscribe cycles. token is the double-opt-in AND the
-- one-click unsubscribe credential (a capability, not a secret derived from
-- anything guessable).
--
-- newsletter_sends: the dedupe ledger. enqueueSweep claims a (post,
-- subscriber) pair with INSERT ... ON CONFLICT DO NOTHING; only the insert
-- that actually landed fires the mail, so concurrent passes / multi-instance
-- deployments cannot double-send, and a re-run after a crash skips anything
-- already claimed. UNIQUE(post_id, subscriber_id) is the contract.
CREATE TABLE IF NOT EXISTS "subscribers" (
  "id" serial PRIMARY KEY,
  "email" text NOT NULL UNIQUE,
  "locale" text NOT NULL DEFAULT 'zh-CN',
  "token" text NOT NULL UNIQUE,
  "confirmed_at" timestamptz,
  "unsubscribed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "newsletter_sends" (
  "id" serial PRIMARY KEY,
  "post_id" integer NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "subscriber_id" integer NOT NULL REFERENCES "subscribers"("id") ON DELETE CASCADE,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "newsletter_sends_post_subscriber_pk" UNIQUE ("post_id", "subscriber_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "newsletter_sends_subscriber_idx" ON "newsletter_sends" ("subscriber_id");
--> statement-breakpoint
