-- R273: the pairing half of per-locale content. translation_of points a
-- non-default-locale post at the id of the post it translates (self for the
-- canonical original is not stored: a zh-CN post IS its own original, so the
-- column stays NULL for it). One nullable FK, ON DELETE SET NULL — deleting an
-- original detaches its translations instead of deleting them.
--
-- No cycle is possible at the schema level, but the API layer rejects a pair
-- whose two rows disagree about locale (a zh post cannot translate a zh post)
-- and re-pointing must target a post of the OPPOSITE locale. The admin API
-- (posts/:id translation patch) is the only writer.
ALTER TABLE "posts" ADD COLUMN "translation_of" integer REFERENCES "posts"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "posts_translation_of_idx" ON "posts" ("translation_of");