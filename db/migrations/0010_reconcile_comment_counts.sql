-- Reconcile denormalized comment counters with the real published comment
-- rows. Earlier demo seeds fabricated comments_count values without creating
-- the comments themselves, so the homepage meta showed impossible numbers.
UPDATE "posts" SET "comments_count" = (
  SELECT count(*) FROM "comments"
  WHERE "comments"."post_id" = "posts"."id"
    AND "comments"."post_type" = 'post'
    AND "comments"."status" = 'published'
);--> statement-breakpoint
UPDATE "pages" SET "comments_count" = (
  SELECT count(*) FROM "comments"
  WHERE "comments"."post_id" = "pages"."id"
    AND "comments"."post_type" = 'page'
    AND "comments"."status" = 'published'
);--> statement-breakpoint
