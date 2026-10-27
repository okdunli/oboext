-- Custom redirects: the table that lets a renamed slug keep its inbound links.
--
-- Before this migration the whole app contained ZERO occurrences of `301` and
-- nine `Response.redirect(...)` calls, all of them 302 session/setup/locale
-- walls. Renaming a post was therefore a silent link delete: `updatePost`
-- (oboext/src/server/admin.ts:573) recomputes the slug, the old URL starts
-- answering 404 through the catch-all, and everything the search engines and
-- third-party sites already point at is lost — after fifteen rounds of SEO
-- work (canonicals, hreflang, feeds, sitemap, JSON-LD) that is the leak this
-- closes.
--
-- Shape notes:
--
--  * `source` is stored as a PATH, always leading-slash, never with a locale
--    prefix, because the matcher receives the already-canonicalised
--    `ctx.pathname`. `/en/blog/x` is looked up as `/blog/x`, so one row serves
--    every language tree and the hit is re-prefixed with the visitor's own
--    locale on the way out.
--  * The uniqueness is on `lower(source)`, not on `source`. Slugs come from
--    titles through `slugify`, but an admin types custom aliases by hand and
--    `/Blog/Old` vs `/blog/old` must not become two rows that answer different
--    casing of the same URL. A plain btree on `source` cannot serve a folded
--    comparison, and the matcher has to fold (`findRedirect` uses
--    `sql\`lower(${redirects.source}) = lower(${path})\``), so the expression
--    index is what makes that lookup an index descent instead of a sequential
--    scan of the table. Same lesson as 0029/0030.
--  * `permanent` splits 301 from 302 because they are not interchangeable:
--    browsers cache a 301 for as long as the domain lives and search engines
--    eventually replace the old URL with the new one. A temporary move has to
--    stay a 302 or it becomes impossible to undo.
--  * `auto` marks the rows this system wrote on a rename rather than an admin
--    typed. It is the difference between "the operator asked for this" and
--    "the software guessed", and an admin screen that cannot tell them apart
--    fills up with rows nobody dares to delete.
--
-- Deliberately absent: no FK to posts/pages. A redirect must outlive the row
-- that produced it (that is the entire point), and a cascade would delete the
-- thing on the same action that creates it.

CREATE TABLE IF NOT EXISTS redirects (
  id serial PRIMARY KEY,
  source text NOT NULL,
  target text NOT NULL,
  permanent boolean NOT NULL DEFAULT true,
  auto boolean NOT NULL DEFAULT false,
  hits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS redirects_source_lower_idx ON redirects (lower(source));
