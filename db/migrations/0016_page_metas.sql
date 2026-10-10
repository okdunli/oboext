-- 独立页面自定义字段表：post_metas 的外键指向 posts，而页面在独立的 pages 表，
-- 页面保存任何自定义字段（如 bluemix 头图 meta 区浏览量开关）都会触发 23503
-- 外键违约。结构与 post_metas 对齐，删除页面时级联清理。
CREATE TABLE IF NOT EXISTS "page_metas" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL REFERENCES "pages"("id") ON DELETE cascade,
	"key" text NOT NULL,
	"value" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_metas_page_idx" ON "page_metas" ("page_id");
