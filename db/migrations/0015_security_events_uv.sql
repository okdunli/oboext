-- extra20：安全事件流水（登录限流计数 + 后台安全日志）与文章 UV 独立访客列。
-- 全部语句幂等，pglite 与 postgres 双驱动均可重复执行。
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "unique_views" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"user_id" integer,
	"account" text,
	"ip" text,
	"user_agent" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_type_idx" ON "security_events" ("event_type", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_account_idx" ON "security_events" ("account", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "post_visitors" (
	"post_id" integer NOT NULL REFERENCES "posts"("id") ON DELETE cascade,
	"visitor_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "post_visitors_pk" ON "post_visitors" ("post_id", "visitor_key");
