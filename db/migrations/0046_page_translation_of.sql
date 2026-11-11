-- Page translation pairs: translation_of points a non-default-locale page at
-- the id of the page it translates (the zh-CN original keeps NULL — it IS the
-- original). Same contract as posts/0043: one nullable self FK, ON DELETE SET
-- NULL, and the API layer rejects a pair whose rows agree about locale.
ALTER TABLE "pages" ADD COLUMN "translation_of" integer REFERENCES "pages"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "pages_translation_of_idx" ON "pages" ("translation_of");
