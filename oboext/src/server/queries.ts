// Read queries for the public site — ported from lib/services/posts.ts and taxonomies.ts.
import { createHash } from "crypto";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db, isConnectionError } from "./db.js";
import { offsetNum } from "./paging.js";
import {
  categories,
  comments,
  postCategories,
  postTags,
  postVisitors,
  posts,
  siteSettings,
  tags,
  users,
  type Post,
  type Category,
  type Tag,
} from "./schema.js";
import {
  getPermalinkConfig,
  postUrlFor,
  categoryUrlFor,
  tagUrlFor,
} from "./links.js";
import { attachPostMetas, getPostMetas } from "./metas.js";
import { buildAdjacent, type AdjacentPair, type AdjacentRow } from "./adjacent.js";
import { uploadExists } from "./storage.js";
import { HOOKS, applyFilters } from "./hooks.js";
import { ServiceError } from "./errors.js";
import { invalidate, memoQuery, memoStrict, SIDEBAR_TTL } from "./cache.js";
import { classifyReferrer, referrerHostOf } from "./referrer.js";
import { ownHost } from "./site-origin.js";
import { createLogger } from "./logger.js";
const log = createLogger("queries");

// Scheduled publishing (time gate): a `published` post whose publishedAt is in the future is "scheduled" and hidden from every public read.
// Exported: widgets.ts reuses this exact predicate in its own post selects.
export const publishedVisible = or(isNull(posts.publishedAt), lte(posts.publishedAt, sql`now()`));

// Nullable on purpose: a root category has parentId = null. A parentId pointing
export type TaxRef = { id: number; name: string; slug: string; url: string; icon?: string | null; parentId?: number | null };

export type PostView = Post & {
  url: string;
  author: { id: number; name: string; email: string } | null;
  categories: TaxRef[];
  tags: TaxRef[];
/** Custom fields (post_metas); themes consume e.g. bluemix_card_theme. */
  metas: Record<string, string>;
  /** Whether THIS request's visitor already liked the post. Absent where the
   *  loader has no visitor to ask about (related, recent, feeds) - the renderers
   *  treat absent as "not liked", so their markup stays byte-identical. */
  liked?: boolean;
};

// on every render - a crawler walking the site turned one absent file into a
const warnedMissingCovers = new Set<string>();

function withUsableCover<T extends { featuredImage?: string | null }>(view: T): T {
  if (view.featuredImage && !uploadExists(view.featuredImage)) {
    if (!warnedMissingCovers.has(view.featuredImage)) {
      warnedMissingCovers.add(view.featuredImage);
      log.warn(
        `[queries] featured_image ${view.featuredImage} is missing on disk, rendering without a cover`,
      );
    }
    return { ...view, featuredImage: null };
  }
  return view;
}

export type PostQuery = {
  status?: string;
  /** R284: exact content-language filter ("zh-CN" | "en"); absent = all. */
  locale?: string;
  authorId?: number;
  categoryId?: number;
  tagId?: number;
  categorySlug?: string;
  tagSlug?: string;
  search?: string;
  year?: number;
  month?: number;
  pinned?: boolean;
  excludeId?: number;
  orderBy?: "date" | "views" | "likes" | "comments";
  random?: boolean;
  limit?: number;
  offset?: number;
  /** R247: raise the window ceiling for machine consumers (sitemap, feeds,
   *  page directory). Never accept this from a request parameter. */
  windowCap?: number;
  /** Ship the full content body (export, GraphQL, RSS). Lists never need it. */
  full?: boolean;
};

// ---------------------------------------------------------------- settings

/**
 * Site settings, memoized hard-TTL.
 *
 * This used to be a hand-rolled `{ at, value }` check-then-set pair, which is
 * not atomic: on a cold process every concurrent reader saw `value === null`
 * and issued its own `select ... from site_settings`. One /archives render
 * selected the row six times. `memoStrict` puts the in-flight promise in
 * shared state before the first await, so concurrent readers share one query
 * and `invalidateSettings()` still drops it immediately on a write.
 */
export async function getSettings(): Promise<Record<string, any>> {
  return memoStrict("settings", 30_000, async () => {
    const rows = await db.select().from(siteSettings).limit(1);
    return rows[0] ?? {};
  });
}

export function invalidateSettings(): void {
  invalidate("settings");
}

// ------------------------------------------------------------ taxonomies

export async function attachTaxonomies(ids: number[]) {
  const cats: Record<number, { id: number; name: string; slug: string }[]> = {};
  const tg: Record<number, { id: number; name: string; slug: string }[]> = {};
  if (!ids.length) return { categories: cats, tags: tg };

  // Two independent reads - one round trip, not two. Against a remote Neon the
  // saved leg is ~20-40ms on every list render and every post hydrate.
  const [ct, tt] = await Promise.all([
    db
      .select({ postId: postCategories.postId, id: categories.id, name: categories.name, slug: categories.slug })
      .from(postCategories)
      .innerJoin(categories, eq(postCategories.categoryId, categories.id))
      .where(inArray(postCategories.postId, ids)),
    db
      .select({ postId: postTags.postId, id: tags.id, name: tags.name, slug: tags.slug })
      .from(postTags)
      .innerJoin(tags, eq(postTags.tagId, tags.id))
      .where(inArray(postTags.postId, ids)),
  ]);

  // join-table physical order (primary category first) is preserved
  for (const row of ct) (cats[row.postId] ??= []).push(row);
  for (const row of tt) (tg[row.postId] ??= []).push(row);
  return { categories: cats, tags: tg };
}

/** Category/tag row plus its public URL under the current permalink config
 *  (original parity: lib/services/taxonomies.ts CategoryWithUrl/TagWithUrl —
 *  the sitemap and the sitemap-plus plugin both read .url). */
export type CategoryWithUrl = Category & { url: string };
export type TagWithUrl = Tag & { url: string };

export async function listCategories(): Promise<CategoryWithUrl[]> {
  return memoQuery("tax:categories", SIDEBAR_TTL, async () => {
    const [rows, cfg] = await Promise.all([
      db.select().from(categories),
      getPermalinkConfig(),
    ]);
    return rows
      .map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }))
      .sort(
        (a, b) =>
          (a.order ?? 0) - (b.order ?? 0) ||
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
          a.id - b.id,
      );
  });
}

/**
 * Published-post count per category id. Themes render it next to the category
 * name; listCategories() carries no count column, and counting per category
 * would be N round trips.
 */
export async function categoryPostCounts(): Promise<Map<number, number>> {
  return memoQuery("tax:catCounts", SIDEBAR_TTL, async () => {
    const rows = await db.execute(sql`select ${postCategories.categoryId} as cid, count(*)::int as n
      from ${postCategories}
      join ${posts} on ${posts.id} = ${postCategories.postId}
      where ${posts.status} = 'published'
        and (${posts.publishedAt} is null or ${posts.publishedAt} <= now())
      group by ${postCategories.categoryId}`);
    const out = new Map<number, number>();
    for (const r of (Array.isArray(rows) ? rows : ((rows as any).rows ?? [])) as any[]) {
      out.set(Number(r.cid), Number(r.n ?? 0));
    }
    return out;
  });
}

/** R148: per-tag published-post counts - the tag-side twin of
 * categoryPostCounts, shared by the sitemap's pagination entries (and any
 * future count consumer) so tag page math never needs its own SQL. */
export async function tagPostCounts(): Promise<Map<number, number>> {
  return memoQuery("tax:tagCounts", SIDEBAR_TTL, async () => {
    const rows = await db.execute(sql`select ${postTags.tagId} as tid, count(*)::int as n
      from ${postTags}
      join ${posts} on ${posts.id} = ${postTags.postId}
      where ${posts.status} = 'published'
        and (${posts.publishedAt} is null or ${posts.publishedAt} <= now())
      group by ${postTags.tagId}`);
    const out = new Map<number, number>();
    for (const r of (Array.isArray(rows) ? rows : ((rows as any).rows ?? [])) as any[]) {
      out.set(Number(r.tid), Number(r.n ?? 0));
    }
    return out;
  });
}

export async function listTags(): Promise<TagWithUrl[]> {
  return memoQuery("tax:tags", SIDEBAR_TTL, async () => {
    const [rows, cfg] = await Promise.all([
      db.select().from(tags).orderBy(desc(tags.id)),
      getPermalinkConfig(),
    ]);
    return rows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) }));
  });
}

/**
 * Slug -> row lookups for the catch-all router.
 *
 * The router probes one of these on EVERY public render to decide whether a
 * path is a taxonomy, and the detail loader then asks for the same row again —
 * two remote round trips per render for a row that changes only on a write.
 * Memoized under the `tax:` prefix, so they share listCategories/listTags'
 * invalidation (invalidateContentCaches drops the whole prefix on any category
 * or tag write) and their TTL: a rename or delete is visible at once.
 */
export async function getCategoryBySlug(slug: string) {
  return memoQuery(`tax:c:${slug}`, SIDEBAR_TTL, async () => {
    const rows = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
    return rows[0] ?? null;
  });
}

export async function getTagBySlug(slug: string) {
  return memoQuery(`tax:t:${slug}`, SIDEBAR_TTL, async () => {
    const rows = await db.select().from(tags).where(eq(tags.slug, slug)).limit(1);
    return rows[0] ?? null;
  });
}

/** Public by-id reads for /api/categories/:id and /api/tags/:id (the original
 *  serves both to guests; a missing row is a 404 ServiceError). */
export async function getCategory(id: number): Promise<Category> {
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  if (!row) throw new ServiceError("分类不存在", 404);
  return row;
}

export async function getTag(id: number): Promise<Tag> {
  const [row] = await db.select().from(tags).where(eq(tags.id, id));
  if (!row) throw new ServiceError("标签不存在", 404);
  return row;
}

// ---------------------------------------------------------------- authors
//
// The public half of a user row. `users.name` carries a UNIQUE index and there
// is no slug column, while an email is a private address the site must not
// publish (the feeds deliberately emit names only) — so the author archive is
// addressed by the numeric id and this projection is the only shape the public
// side can read: no role, no hash, no phone, no last-login.

export type PublicAuthor = {
  id: number;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
};

/** id -> public author, or null when the account does not exist or is not an
 * active one (a disabled or unverified-banned account gets a 404, not a
 * stripped profile). Memoized like getCategoryBySlug: the catch-all router
 * asks on every render and the loader asks again. */
export async function getPublicAuthor(id: number): Promise<PublicAuthor | null> {
  return memoQuery(`tax:author:${id}`, SIDEBAR_TTL, async () => {
    const [row] = await db
      .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl, bio: users.bio })
      .from(users)
      .where(and(eq(users.id, id), eq(users.status, "active")))
      .limit(1);
    return row ?? null;
  });
}

/** Published-post count per author id — the archive's "N posts" line and the
 * sitemap's author family. posts.authorId is nullable, so the map keeps a 0
 * bucket that callers must not turn into a URL. */
export async function authorPostCounts(): Promise<Map<number, number>> {
  return memoQuery("tax:authorCounts", SIDEBAR_TTL, async () => {
    const rows = await db.execute(sql`select ${posts.authorId} as aid, count(*)::int as n
      from ${posts}
      where ${posts.authorId} is not null
        and ${posts.status} = 'published'
        and (${posts.publishedAt} is null or ${posts.publishedAt} <= now())
      group by ${posts.authorId}`);
    const out = new Map<number, number>();
    for (const r of (Array.isArray(rows) ? rows : ((rows as any).rows ?? [])) as any[]) {
      if (r.aid === null || r.aid === undefined) continue;
      out.set(Number(r.aid), Number(r.n ?? 0));
    }
    return out;
  });
}

/** Active accounts (id + name only). The sitemap joins these against
 * authorPostCounts() so only authors with at least one public post get
 * advertised — an empty archive is a thin-content page, not a landing page. */
export async function listAuthorRows(): Promise<Array<{ id: number; name: string }>> {
  return memoQuery("tax:authors", SIDEBAR_TTL, async () => {
    return await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.status, "active"))
      .orderBy(asc(users.name), asc(users.id));
  });
}

// ------------------------------------------------------------- post lists

/**
 * Split a raw search box value into terms: whitespace-separated (CJK included),
 * empties dropped, duplicates collapsed, capped at 8 so a paste bomb cannot
 * fan out into an unbounded AND chain. Callers AND the terms together, so
 * "LoRa 模组" means "both words somewhere in title/excerpt".
 */
export function searchTerms(q: string | undefined | null): string[] {
  const raw = (q ?? "").trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(/\s+/)) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Escape the ILIKE wildcards (%, _, \) inside one term. Without this a user
 * query of "%" or "_" turns the pattern into a match-everything scan - the
 * search box then answers a different question than the one asked. Pair with
 * an ESCAPE '\' clause on the ILIKE.
 */
export function ilikeEscape(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

// ------------------------------------------------- search relevance (R250)

/**
 * Is there a latin word in the query? Two letters or more, which is also what
 * separates a real word from a stray initial ("C.", "R250"). This gates the
 * tsvector ranking: to_tsvector('simple', ...) has no CJK segmentation, so a
 * Chinese phrase becomes ONE lexeme and '模组' only matches a document whose
 * whole unspaced run is exactly '模组' — the rank is 0 for every other row and
 * the ordering it produces is noise. Latin is where ts_rank earns its keep.
 */
export function hasLatinWord(q: string | undefined | null): boolean {
  return /[A-Za-z]{2,}/.test(String(q ?? ""));
}

/** The query as websearch_to_tsquery wants it: no operator punctuation survives
 * to be parsed as syntax. Everything that is not a word character becomes a
 * space, so `"lora" OR`, `a AND`, `(((` and `' OR "` all degrade to a plain
 * AND-of-words query instead of a syntax error. */
function tsQueryText(q: string): string {
  return String(q ?? "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The weighted relevance document shared by migration 0037's index and the
 * ORDER BY below. It must be byte-identical in both places or the index is
 * dead weight: PostgreSQL matches an expression index on the expression's
 * normalized form, so "the same thing written differently" silently stops
 * using it. Title 'A' outranks excerpt 'B'; the body is deliberately NOT in
 * the document (see the migration comment for the measurement).
 */
function tsRankDoc(title: unknown, excerpt: unknown): SQL {
  return sql`(setweight(to_tsvector('simple', coalesce(${title}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${excerpt}, '')), 'B'))`;
}

/**
 * A `ts_rank(...) DESC` order term for a latin query, or null when the ranking
 * must stay out of the way. Null for a CJK-only or digit-only query (the gate
 * above), and null when the query is punctuation to the point that no word
 * survives — ranking by an empty tsquery would be a no-op that still pays for
 * the to_tsvector call on every candidate row.
 *
 * This only ever adds an ORDER BY term; the WHERE clause is untouched ILIKE,
 * so the result set cannot change.
 */
export function tsRankOrder(
  title: unknown,
  excerpt: unknown,
  q: string | undefined | null,
): SQL | null {
  const raw = String(q ?? "").trim();
  if (!raw || !hasLatinWord(raw)) return null;
  const text = tsQueryText(raw);
  if (!text) return null;
  const doc = tsRankDoc(title, excerpt);
  return sql`ts_rank(${doc}, websearch_to_tsquery('simple', ${text})) DESC`;
}

// ------------------------------------------------------- search highlight

/**
 * HTML-escape one string the same way render.ts esc() does (kept local so this
 * module stays out of render.ts's import graph — render.ts imports THIS one).
 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Case-insensitive keyword highlight for search-result title/excerpt. The
 * safety invariant is escape-before-wrap, kept per segment: the RAW text is
 * split at keyword boundaries, every slice is HTML-escaped, and only the
 * escaped hit slice gets wrapped in <mark> — no user-controlled byte is ever
 * emitted unescaped, and the <mark> tags are the only raw markup in the
 * result. Matching runs on the RAW text (not the escaped one) so a query like
 * "amp" cannot land inside an entity body and split "&amp;" into visible
 * garbage. Terms come from the same searchTerms() split the query ran, so
 * "LoRa 模组" highlights both words independently; empty query and terms over
 * 50 chars (paste bombs / hash junk the SQL never matches word-wise) skip
 * highlighting; regex metacharacters are escaped for the RegExp — a "%"/"_"
 * query is a wildcard to SQL but a literal to this wrapper, the same
 * asymmetry the client-side F4 highlight already lives with.
 */
export function searchHighlight(text: string, q: string | undefined | null): string {
  const raw = String(text ?? "");
  const words = searchTerms(q)
    .filter((t) => t.length <= 50)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return escHtml(raw);
  const re = new RegExp(`(${words.join("|")})`, "gi");
  let out = "";
  let last = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    if (m.index > last) out += escHtml(raw.slice(last, m.index));
    out += `<mark>${escHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // guard, though searchTerms drops empties
  }
  out += escHtml(raw.slice(last));
  return out;
}

// ------------------------------------------------------- search suggest

/** Context kept on each side of the hit in a suggestion snippet. */
const SUGGEST_WINDOW = 20;

/**
 * Case-insensitive title de-dup for the suggest popover: the same article must
 * not occupy two of the five rows (a duplicated title reads as a rendering
 * bug). First occurrence wins, original order preserved.
 */
export function suggestDedupe<T extends { title?: string | null }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const key = String(p.title ?? "").trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The `hl` field of a suggestion: a ~20-char window around the first hit with
 * the term wrapped in \u0001…\u0002 instead of <mark>. This value crosses JSON
 * into the popover, where the CLIENT owns the markup, so no HTML may leave
 * here — the markers are the whole contract (`hl.split("\u0001")`).
 * Raw `<`/`>`/`&` are dropped so a title byte can never close the client's
 * <mark> wrapper. The window is sliced by code point, so a CJK/emoji boundary
 * cannot split a surrogate pair. No hit or blank query answers "".
 *
 * shortcut: a query containing `<`/`>`/`&` cannot match here (the bytes are
 * stripped from the text before matching); upgrade if such titles must
 * highlight — the client would then need a text-node renderer.
 */
export function suggestHighlight(text: string, q: string | undefined | null): string {
  const plain = String(text ?? "").replace(/[<>&]/g, "");
  const words = searchTerms(q)
    .filter((t) => t.length <= 50)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return "";
  const m = new RegExp(words.join("|"), "i").exec(plain);
  if (!m) return "";
  const chars = Array.from(plain);
  const start = Array.from(plain.slice(0, m.index)).length;
  const end = start + Array.from(m[0]).length;
  const from = Math.max(0, start - SUGGEST_WINDOW);
  const to = Math.min(chars.length, end + SUGGEST_WINDOW);
  return (
    (from > 0 ? "…" : "") +
    chars.slice(from, start).join("") +
    "\u0001" +
    chars.slice(start, end).join("") +
    "\u0002" +
    chars.slice(end, to).join("") +
    (to < chars.length ? "…" : "")
  );
}

/**
 * Filter signature for the native pinned-id set. The pinned SELECT's WHERE is
 * built from exactly these fields (the pinned branch below already rejects
 * random/search/excludeId, so they can never appear here), which makes this
 * string that query's entire input.
 */
function pinSig(opts: PostQuery): string {
  return [
    opts.status ?? "",
    opts.authorId ?? "",
    opts.categoryId ?? "",
    opts.tagId ?? "",
    opts.categorySlug ?? "",
    opts.tagSlug ?? "",
    opts.year ?? "",
    opts.month ?? "",
  ].join("|");
}

/**
 * The native `posts.pinned` id set for one archive filter.
 *
 * listPostsRaw asks for this on every call that allows pinning, and one page
 * runs listPosts several times with the SAME filter but a different limit or
 * orderBy (home's main list plus its popular/ranking lists; a post page's
 * sidebar plus its related list). Each of those re-ran this SELECT, and it sits
 * on the serial path BEFORE the main list query - so it cost a full extra round
 * trip per list. One entry per filter signature serves every list on the page;
 * writes drop `pin:` through invalidateContentCaches.
 */
function pinnedIdsFor(sig: string, where: any): Promise<number[]> {
  return memoQuery(`pin:${sig}`, SIDEBAR_TTL, async () => {
    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(where ? and(where, eq(posts.pinned, true)) : eq(posts.pinned, true));
    return rows.map((r) => r.id);
  });
}

/**
 * R157/R158: one place that turns whatever a caller passed into a legal SQL
 * window. Public and session routes pass `Number(q.get("limit"))` straight
 * through, so without this `/api/posts?limit=abc` reached `.limit(NaN)` and
 * `?limit=-5` / `?offset=-3` became negative LIMIT/OFFSET - trivially
 * reachable Postgres errors (500s). limit: NaN -> the caller's default,
 * negatives -> the nearest legal value, ceiling stays 100; offset: NaN -> 0,
 * negative -> 0 (no upper cap - deep pagination links must keep working).
 * Exported in R158 so pages/media windows clamp by the SAME arithmetic.
 *
 * R247: `windowCap` raises the ceiling for MACHINE consumers only — the
 * sitemap and the page directory list the whole site, and their
 * `limit: 10000/500` was being silently clamped to 100 (the same value as a
 * visitor's `?limit=100`), so a blog past 100 posts shipped a truncated map
 * while its sharding code never fired. User-facing routes keep the 100 cap.
 */
export function normalizeWindow(
  opts: { limit?: unknown; offset?: unknown },
  defaultLimit = 20,
  windowCap = 100,
): { limit: number; offset: number } {
  const rawLimit = Number(opts.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), windowCap)
    : defaultLimit;
  const offset = offsetNum(opts.offset);
  return { limit, offset };
}

/** The machine-consumer ceiling: full-site listings (sitemap, page directory,
 *  feeds at their configured size) need the real count, not a visitor's page
 *  size. Not reachable from any request parameter — callers pass it literally. */
export const MACHINE_WINDOW_CAP = 10_000;

export async function listPostsRaw(
  opts: PostQuery = {},
): Promise<{ items: PostView[]; total: number }> {
  const { limit, offset } = normalizeWindow(opts, 20, opts.windowCap);
  const conditions: any[] = [];

  if (opts.status) conditions.push(eq(posts.status, opts.status as any));
  // R284: exact content-language filter (validated by the callers that expose it).
  if (opts.locale) conditions.push(eq(posts.locale, opts.locale));
  // scheduled: future-dated published posts stay out of every public listing
  if (opts.status === "published") conditions.push(publishedVisible);
  if (opts.authorId) conditions.push(eq(posts.authorId, opts.authorId));
  if (opts.categoryId)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${postCategories} pc WHERE pc.post_id = ${posts.id} AND pc.category_id = ${opts.categoryId})`,
    );
  if (opts.tagId)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${postTags} pt WHERE pt.post_id = ${posts.id} AND pt.tag_id = ${opts.tagId})`,
    );
  if (opts.categorySlug)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${postCategories} pc JOIN ${categories} c ON c.id = pc.category_id WHERE pc.post_id = ${posts.id} AND c.slug = ${opts.categorySlug})`,
    );
  if (opts.tagSlug)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${postTags} pt JOIN ${tags} t ON t.id = pt.tag_id WHERE pt.post_id = ${posts.id} AND t.slug = ${opts.tagSlug})`,
    );
  // Search terms are AND-ed, each matching title OR excerpt OR a tag/category
  // name (recall: a post tagged "docker" surfaces for "docker" even when the
  // word sits in neither its title nor its excerpt). Wildcards inside a term
  // are escaped so a bare "%" cannot answer a different question.
  const taxTermMatch = (t: string) =>
    sql`(EXISTS (SELECT 1 FROM ${postTags} pt JOIN ${tags} tg ON tg.id = pt.tag_id WHERE pt.post_id = ${posts.id} AND tg.name ILIKE ${"%" + t + "%"} ESCAPE '\\') OR EXISTS (SELECT 1 FROM ${postCategories} pc JOIN ${categories} cc ON cc.id = pc.category_id WHERE pc.post_id = ${posts.id} AND cc.name ILIKE ${"%" + t + "%"} ESCAPE '\\'))`;
  const searchTermsEsc = searchTerms(opts.search).map(ilikeEscape);
  if (searchTermsEsc.length) {
    conditions.push(
      and(
        ...searchTermsEsc.map((t) =>
          sql`(${posts.title} ILIKE ${"%" + t + "%"} ESCAPE '\\' OR ${posts.excerpt} ILIKE ${"%" + t + "%"} ESCAPE '\\' OR ${posts.bodyPlain} ILIKE ${"%" + t + "%"} ESCAPE '\\' OR ${taxTermMatch(t)})`,
        ),
      ),
    );
  }
  if (opts.year) conditions.push(sql`EXTRACT(YEAR FROM ${posts.publishedAt}) = ${opts.year}`);
  if (opts.month) conditions.push(sql`EXTRACT(MONTH FROM ${posts.publishedAt}) = ${opts.month}`);
  if (opts.excludeId) conditions.push(sql`${posts.id} <> ${opts.excludeId}`);

  const where = conditions.length ? and(...conditions) : undefined;

  // Floating posts: plugin-contributed ordered ids (posts.pinned hook, e.g.
  // sticky-posts) first, then the native posts.pinned flag. The middleware
  // ensures plugins are loaded before any public list renders.
  let floatingIds: number[] = [];
  if (
    opts.status === "published" &&
    opts.pinned !== false &&
    !opts.random &&
    !opts.search &&
    !opts.excludeId
  ) {
    const contributed = applyFilters<{ query: PostQuery; ids: number[] }>(HOOKS.postsPinned, {
      query: opts,
      ids: [],
    });
    const wanted = contributed.ids.filter((n) => Number.isInteger(n) && n > 0);
    if (wanted.length) {
      // Keep only ids that satisfy this archive's own filters (category/tag/. )
      const valid = await db
        .select({ id: posts.id })
        .from(posts)
        .where(where ? and(where, inArray(posts.id, wanted)) : inArray(posts.id, wanted));
      const validSet = new Set(valid.map((r) => r.id));
      floatingIds = wanted.filter((id) => validSet.has(id));
    }
    for (const id of await pinnedIdsFor(pinSig(opts), where)) {
      if (!floatingIds.includes(id)) floatingIds.push(id);
    }
  }
  const normalWhere = floatingIds.length
    ? where
      ? and(where, notInArray(posts.id, floatingIds))
      : notInArray(posts.id, floatingIds)
    : where;

  // Relevance first when searching: title matching the whole query > title
  // matching any term > excerpt matching the whole query > a tag/category name
  // matching > everything else, then the archive's own order. id is the final
  // tiebreaker so OFFSET pagination can never duplicate or skip a row.
  //
  // R250: for a latin query the CASE above is only a coarse bucket (89 rows
  // shared bucket 1 for "lora module" in the measurement), so a real relevance
  // score is layered BETWEEN the bucket and the date - never in front of it, so
  // a title hit can never be pushed below a body hit by term density.
  const wholeQuery = ilikeEscape((opts.search ?? "").trim());
  const searchRank: any[] = [];
  if (searchTermsEsc.length) {
    searchRank.push(sql`(CASE
      WHEN ${posts.title} ILIKE ${"%" + wholeQuery + "%"} ESCAPE '\\' THEN 0
      WHEN ${sql.join(
        searchTermsEsc.map((t) => sql`${posts.title} ILIKE ${"%" + t + "%"} ESCAPE '\\'`),
        sql` OR `,
      )} THEN 1
      WHEN ${posts.excerpt} ILIKE ${"%" + wholeQuery + "%"} ESCAPE '\\' THEN 2
      WHEN ${sql.join([taxTermMatch(wholeQuery), ...searchTermsEsc.map(taxTermMatch)], sql` OR `)} THEN 3
      WHEN ${posts.bodyPlain} ILIKE ${"%" + wholeQuery + "%"} ESCAPE '\\' THEN 4
      ELSE 5 END)`);
    const rk = tsRankOrder(posts.title, posts.excerpt, opts.search);
    if (rk) searchRank.push(rk);
  }

  const order = opts.random
    ? [sql`random()`]
    : [
        ...searchRank,
        ...(opts.orderBy === "views"
          ? [desc(posts.views), desc(posts.publishedAt)]
          : opts.orderBy === "likes"
            ? [desc(posts.likes), desc(posts.publishedAt)]
            : opts.orderBy === "comments"
              ? [desc(posts.commentsCount), desc(posts.publishedAt)]
              : [desc(posts.publishedAt), desc(posts.createdAt)]),
        desc(posts.id),
      ];

  // Content bodies are the heavy column (hundreds of KB per post). Lists
  // render title/excerpt/url only, so the default select ships '' in its place
  // — on a remote DB this is the difference between a list query carrying
  // kilobytes and one carrying megabytes. Export, GraphQL and RSS pass
  // full: true to get the real body back.
  //
  // R201: body_plain (the R200 searchable projection of the body) is the SAME
  // weight of column and belongs to the SAME rule — it exists only to be
  // matched in WHERE/RANK, and no renderer reads it. Selecting it made every
  // list query carry the plain text of every post: measured at 90.8% of the
  // /api/posts payload (176 KB of 194 KB for 20 posts with 8.8 KB bodies),
  // which defeated the content-blanking above. It is dropped from every read
  // shape, not just the list one.
  // R201: body_plain is the searchable projection of the body and carries the
  // SAME weight as content (the whole body as plain text). It exists only to be
  // matched in WHERE/RANK — no renderer reads it. Dropping it from the list
  // shape keeps list queries as light as the content-blanking above intends.
  const postShape: typeof posts = opts.full
    ? posts
    : ({ ...getTableColumns(posts), content: sql<string>`''`, bodyPlain: sql<string>`NULL` } as typeof posts);
  const rowShape = { post: postShape, authorName: users.name, authorEmail: users.email, authorId: users.id };
  type JoinedRow = { post: Post; authorName: string | null; authorEmail: string | null; authorId: number | null };

  let pinnedRows: JoinedRow[] = [];
  let normalLimit = limit;
  let normalOffset = offset;
  if (floatingIds.length) {
    const floatStart = offset;
    const floatEnd = Math.min(floatingIds.length, offset + limit);
    if (floatEnd > floatStart) {
      const want = floatingIds.slice(floatStart, floatEnd);
      const found = await db
        .select(rowShape)
        .from(posts)
        .leftJoin(users, eq(posts.authorId, users.id))
        .where(inArray(posts.id, want));
      const byId = new Map(found.map((r) => [r.post.id, r]));
      pinnedRows = want.map((id) => byId.get(id)).filter((r): r is JoinedRow => Boolean(r));
    }
    normalLimit = limit - pinnedRows.length;
    normalOffset = Math.max(0, offset - floatingIds.length);
  }

  // The total matching count rides the main query as a window function
  // (evaluated before LIMIT/OFFSET) — one round trip instead of two. The
  // separate count query stays for the pinned-paged path and when the page
  // is empty (a window value needs at least one returned row).
  const withTotal = floatingIds.length === 0 && normalLimit > 0;
  const normalRows: JoinedRow[] =
    normalLimit > 0
      ? await db
          .select(withTotal ? { ...rowShape, total: sql<number>`count(*) over()` } : rowShape)
          .from(posts)
          .leftJoin(users, eq(posts.authorId, users.id))
          .where(normalWhere)
          .orderBy(...(order as any))
          .limit(normalLimit)
          .offset(normalOffset)
      : [];

  const rows = pinnedRows.concat(normalRows);

  let total: number;
  if (withTotal && normalRows.length > 0) {
    total = Number((normalRows[0] as any).total ?? 0);
  } else {
    const totalRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(posts)
      .where(where);
    total = Number(totalRows[0]?.count ?? 0);
  }

  const cfg = await getPermalinkConfig();
  const ids = rows.map((r) => r.post.id);
  const [tax, metaMap] = await Promise.all([attachTaxonomies(ids), attachPostMetas(ids)]);

  const items: PostView[] = rows.map((r) => withUsableCover({
    ...r.post,
    url: postUrlFor(cfg, r.post),
    author: r.authorId ? { id: r.authorId, name: r.authorName!, email: r.authorEmail! } : null,
    categories: (tax.categories[r.post.id] ?? []).map((c) => ({ ...c, url: categoryUrlFor(cfg, c) })),
    tags: (tax.tags[r.post.id] ?? []).map((t) => ({ ...t, url: tagUrlFor(cfg, t) })),
    metas: metaMap[r.post.id] ?? {},
  }));

  return { items, total };
}

/**
 * Public listPosts with a data-layer TTL cache. Search, year and month filters
 * are cacheable too (their keys include the term, the LRU bounds key growth,
 * and every content write drops the whole `lp:` prefix) — only random picks
 * and excludeId windows stay uncached, because their results must differ on
 * every call. `invalidateContentCaches()` drops every entry on a content write.
 */
export async function listPosts(
  opts: PostQuery = {},
): Promise<{ items: PostView[]; total: number }> {
  const cacheable = !opts.random && !opts.excludeId;
  if (!cacheable) return listPostsRaw(opts);
  // R157: the memo key is built from the NORMALIZED window too - otherwise
  // `limit=abc` and `limit=20` (which now produce identical results) would
  // occupy separate entries, and `-5`/`-3` would key on values that never
  // reach SQL.
  const normalized = { ...opts, ...normalizeWindow(opts, 20, opts.windowCap) };
  const key = `lp:${JSON.stringify(normalized)}`;
  return memoQuery(key, SIDEBAR_TTL, () => listPostsRaw(normalized));
}

/**
 * The search middleware's single-hit redirect: does the cleaned query match
 * exactly one published post? One lean select (six columns, limit 2) instead
 * of the full listPosts() pipeline the old searchRedirect() paid — content
 * bodies, taxonomies and metas shipped over the wire just to answer a boolean,
 * then the page loader ran the same pipeline again. Memoized 60s under `sred:`
 * (dropped by invalidateContentCaches, same contract as `lp:`).
 */
export async function searchSingleHit(q: string): Promise<string | null> {
  const cleaned = q.trim();
  if (!cleaned) return null;
  const terms = searchTerms(cleaned).map(ilikeEscape);
  if (!terms.length) return null;
  return memoQuery<string | null>(`sred:${cleaned}`, 60_000, async () => {
    const rows = await db
      .select({
        id: posts.id,
        slug: posts.slug,
        pinyinSlug: posts.pinyinSlug,
        initialSlug: posts.initialSlug,
        publishedAt: posts.publishedAt,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(
        and(
          eq(posts.status, "published"),
          publishedVisible,
          and(
            ...terms.map((t) =>
              sql`(${posts.title} ILIKE ${"%" + t + "%"} ESCAPE '\\' OR ${posts.excerpt} ILIKE ${"%" + t + "%"} ESCAPE '\\' OR ${posts.bodyPlain} ILIKE ${"%" + t + "%"} ESCAPE '\\')`,
            ),
          ),
        ),
      )
      .limit(2);
    if (rows.length !== 1) return null;
    return postUrlFor(await getPermalinkConfig(), rows[0]);
  });
}

/** The raw post+author row a post lookup returns, BEFORE hydration. Carried
 *  through resolveSitePath so the detail loader can fold the hydration reads
 *  (taxonomies + metas) into its own concurrency wave instead of paying a
 *  dedicated round trip per cold view. */
export type PostRow = {
  post: Post;
  authorName: string | null;
  authorEmail: string | null;
  authorId: number | null;
};

/**
 * Hydrate a raw post row into a public view (taxonomies + metas + author +
 * url). Memoized (SWR, SIDEBAR_TTL) under `hydr:` — the two reads it joins are
 * per-render cost on every cold post view, and the row it starts from is
 * already memoized at `rp:`. `preview` is part of the key: a draft hydrated
 * for its author must never be served to a public reader from the same entry.
 */
export async function hydrate(row: PostRow, opts: { preview?: boolean } = {}): Promise<PostView> {
  return memoQuery(`hydr:${row.post.id}:${opts.preview ? 1 : 0}`, SIDEBAR_TTL, async () => {
    const [cfg, tax, metas] = await Promise.all([
      getPermalinkConfig(),
      attachTaxonomies([row.post.id]),
      getPostMetas(row.post.id),
    ]);
    const item: PostView = withUsableCover({
      ...row.post,
      url: postUrlFor(cfg, row.post),
      author: row.authorId
        ? { id: row.authorId, name: row.authorName!, email: row.authorEmail! }
        : null,
      categories: (tax.categories[row.post.id] ?? []).map((c) => ({ ...c, url: categoryUrlFor(cfg, c) })),
      tags: (tax.tags[row.post.id] ?? []).map((t) => ({ ...t, url: tagUrlFor(cfg, t) })),
      metas,
    });
    return item;
  });
}

/**
 * Published post by any stored tail — slug, pinyin, initials or numeric id.
 *
 * The active permalink mode only decides which column is tried FIRST (that is
 * the indexed hot path); every column is still tried afterwards. Without the
 * fallbacks a caller that already holds the post and re-resolves by `slug`
 * (the catch-all loader's postDetail) would 404 under postMode pinyin/initial,
 * because the mode's own column no longer matches.
 */
export async function getPostRow(tail: string, opts: { preview?: boolean } = {}): Promise<PostRow | null> {
  const cfg = await getPermalinkConfig();

  // The fallback chain (slug -> pinyin -> initial -> id) used to be up to four
  // serial full-row fetches; on a miss — every 404 probe through
  // resolveSitePath — ALL of them ran before the caller could conclude "no
  // such post". One OR query with a boolean-priority ORDER BY returns exactly
  // the row the chain would have: an exact match on an earlier preference
  // column wins, which is the row the old first-success loop stopped on.
  const cols = { slug: posts.slug, pinyin: posts.pinyinSlug, initial: posts.initialSlug } as const;
  type Col = keyof typeof cols;
  const prefOrder: Col[] =
    cfg.postMode === "pinyin"
      ? ["pinyin", "slug", "initial"]
      : cfg.postMode === "initial"
        ? ["initial", "slug", "pinyin"]
        : ["slug", "pinyin", "initial"];
  const isId = /^\d+$/.test(tail);
  // id is tried FIRST only in postMode "id"; other modes keep it last, after
  // every text column, exactly like the old `if (!row && isId)` tail.
  if (cfg.postMode === "id" && isId) prefOrder.unshift("id");
  const conds = prefOrder.map((k) => (k === "id" ? eq(posts.id, Number(tail)) : eq(cols[k], tail)));
  const priority = prefOrder.map((k) =>
    k === "id" ? sql`(${posts.id} = ${Number(tail)}) DESC` : sql`(${cols[k]} = ${tail}) DESC`,
  );
  if (cfg.postMode !== "id" && isId) {
    conds.push(eq(posts.id, Number(tail)));
    priority.push(sql`(${posts.id} = ${Number(tail)}) DESC`);
  }

  const [row] = await db
    .select({ post: posts, authorName: users.name, authorEmail: users.email, authorId: users.id })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .where(and(...(opts.preview ? [] : [eq(posts.status, "published"), publishedVisible]), or(...conds)))
    .orderBy(...priority)
    .limit(1);
  return row ?? null;
}

/** Published post by any stored tail — slug, pinyin, initials or numeric id —
 *  fully hydrated (taxonomies + metas + author + url). The detail loader uses
 *  getPostRow + hydrate directly so the hydration reads ride its wave. */
export async function getPost(tail: string, opts: { preview?: boolean } = {}): Promise<PostView | null> {
  const row = await getPostRow(tail, opts);
  return row ? hydrate(row, opts) : null;
}

/** Public single-post read by numeric id (published only); null when absent
 *  or the id is not a positive integer. Mirrors the original /api/posts/:id
 *  guest branch. */
export async function getPublishedPostById(id: number): Promise<PostView | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await db
    .select({ post: posts, authorName: users.name, authorEmail: users.email, authorId: users.id })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .where(and(eq(posts.status, "published"), publishedVisible, eq(posts.id, id)))
    .limit(1);
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function relatedPosts(postId: number, n = 4): Promise<PostView[]> {
  // excludeId makes the underlying list uncacheable by listPosts itself, so
  // every post view paid the whole pipeline (floating-pin probes, main select,
  // taxonomies, metas) on a per-cookie render cache miss. The related set
  // changes only when content does: memoize per (post, n) and let
  // invalidateContentCaches drop it on writes. Takes the id (not the whole
  // view) so the caller can issue it from the raw row, inside its wave.
  return memoQuery(`rel:${postId}:${n}`, SIDEBAR_TTL, async () => {
    const { items } = await listPosts({
      status: "published",
      pinned: false,
      excludeId: postId,
      orderBy: "date",
      limit: n,
    });
    return items;
  });
}

/**
 * The two neighbours of a post for 上一篇/下一篇 navigation.
 *
 * One statement, one round trip: two LIMIT 1 selects UNION ALL'd, each
 * direction-tagged, so a cold post view pays a single Neon RTT for the pair.
 * Ordering key is `coalesce(published_at, created_at)` — the same total
 * order the visibility gate implies, so posts with a null publishedAt (never
 * scheduled) still have a position instead of vanishing from the sequence.
 * The `posts_status_published_idx` (status, published_at) index serves the
 * range scan; `id` is only a tiebreaker inside the same key value.
 *
 * Memoized per (post, key): the pair changes only when a neighbour is
 * published/unpublished/re-dated, and invalidateContentCaches drops the entry
 * on every content write. The key rides the memo key so re-dating the current
 * post itself cannot serve a stale pair.
 */
export async function getAdjacentPosts(postId: number, key: Date): Promise<AdjacentPair> {
  // The key rides as an ISO string cast with ::timestamptz — binding a raw JS
  // Date makes the driver compare against a non-timestamp (the R25 cursor
  // lesson: `${text}::timestamptz`, never a bare Date object).
  const keyIso = key.toISOString();
  return memoQuery(`adj:${postId}:${keyIso}`, SIDEBAR_TTL, async () => {
    const [rows, cfg] = await Promise.all([
      db.execute(sql`
        select * from (
          (select 'newer' as "dir", "id", "title", "slug", "published_at", "created_at"
             from ${posts}
            where "status" = 'published'
              and ("published_at" is null or "published_at" <= now())
              and "id" <> ${postId}
              and coalesce("published_at", "created_at") > ${keyIso}::timestamptz
            order by coalesce("published_at", "created_at") asc, "id" asc
            limit 1)
          union all
          (select 'older' as "dir", "id", "title", "slug", "published_at", "created_at"
             from ${posts}
            where "status" = 'published'
              and ("published_at" is null or "published_at" <= now())
              and "id" <> ${postId}
              and coalesce("published_at", "created_at") < ${keyIso}::timestamptz
            order by coalesce("published_at", "created_at") desc, "id" desc
            limit 1)
        ) t
      `),
      getPermalinkConfig(),
    ]);
    const list = (Array.isArray(rows) ? rows : ((rows as any).rows ?? [])) as AdjacentRow[];
    return buildAdjacent(list, (r) =>
      postUrlFor(cfg, {
        id: Number(r.id),
        slug: String(r.slug ?? ""),
        publishedAt: r.publishedAt == null ? null : new Date(r.publishedAt as string),
      }),
    );
  });
}

export async function relatedByTaxonomy(postId: number, limit = 4): Promise<PostView[]> {
  // Same contract as relatedPosts: per-view reads of a rarely-changing set,
  // memoized per (post, limit) and dropped by invalidateContentCaches.
  return memoQuery(`reltax:${postId}:${limit}`, SIDEBAR_TTL, async () => {
  // One query, not a wave chain: the post's own category/tag ids (the old
  // first UNION) are a `mine` CTE the membership scan joins against in the
  // same statement. The old shape ran the scan as a second round trip that
  // depended on the first - two full Neon RTTs on a cold post view. The
  // empty-taxonomy case now falls out naturally: `mm` comes back empty and
  // the listPosts fallback below runs, same as before.
  // Drizzle expands an interpolated JS array into a parenthesized placeholder
  // tuple, which `= any(...)` rejects at the driver - but no JS arrays are
  // bound here; every value is a scalar parameter.
  const [scoredRows, cfg] = await Promise.all([
    db.execute(sql`
      with mine as (
        select "category_id" as "id", 'c' as "kind" from ${postCategories} where "post_id" = ${postId}
        union all
        select "tag_id" as "id", 't' as "kind" from ${postTags} where "post_id" = ${postId}
      )
      select p."id", p."title", p."slug", p."published_at", p."featured_image",
             sum(case mm."kind" when 'c' then 3 else 2 end)::int as "score"
      from (
        select mc."post_id", mine."kind" from ${postCategories} mc
          join mine on mc."category_id" = mine."id" and mine."kind" = 'c'
        union all
        select mt."post_id", mine."kind" from ${postTags} mt
          join mine on mt."tag_id" = mine."id" and mine."kind" = 't'
      ) mm
      join ${posts} p on p."id" = mm."post_id"
      where p."status" = 'published'
        and (p."published_at" is null or p."published_at" <= now())
        and p."id" <> ${postId}
      group by p."id", p."title", p."slug", p."published_at", p."featured_image"
      order by "score" desc, p."published_at" desc nulls last
      limit ${limit}`),
    getPermalinkConfig(),
  ]);
  const scored = (Array.isArray(scoredRows) ? scoredRows : (scoredRows as any).rows) as {
    id: number;
    title: string;
    slug: string;
    published_at: Date | null;
    featured_image: string | null;
  }[];
  if (!scored.length) {
    const { items } = await listPosts({ status: "published", excludeId: postId, orderBy: "date", limit });
    return items;
  }
  return scored
    .map((p) => ({
      id: Number(p.id),
      title: p.title,
      slug: p.slug,
      publishedAt: p.published_at,
      featuredImage: p.featured_image,
      url: postUrlFor(cfg, { id: Number(p.id), slug: p.slug, publishedAt: p.published_at }),
    })) as unknown as PostView[];
  });
}

// ---------------------------------------------------------------- comments

/**
 * Published comments for one content item, oldest first (tree order).
 *
 * R154: the 200 cap used to be taken from the OLDEST end - a long thread
 * silently dropped its TAIL, i.e. the recent discussion readers came for, with
 * no UI anywhere to reach it (while the comment count and the comments feed
 * kept advertising the full total). Same cap, opposite window: take the
 * NEWEST 200, then re-emit them in tree (asc id) order. Under the cap - the
 * overwhelmingly common case - that is ONE query (desc page, reversed);
 * only a >200 thread pays a second `inArray` query to restore asc order.
 * Replies whose parent fell outside the window surface as ROOTS through
 * buildCommentTree's orphan branch instead of vanishing.
 */
export async function listPostComments(
  postId: number,
  postType = "post",
): Promise<Array<{
  id: number;
  parentId: number | null;
  authorName: string;
  authorEmail: string | null;
  authorUrl: string | null;
  content: string;
  createdAt: Date;
}>> {
  const shape = {
    id: comments.id,
    parentId: comments.parentId,
    authorName: comments.authorName,
    authorEmail: comments.authorEmail,
    authorUrl: comments.authorUrl,
    content: comments.content,
    createdAt: comments.createdAt,
  };
  const where = and(
    eq(comments.postId, postId),
    eq(comments.postType, postType),
    eq(comments.status, "published"),
  );
  const tail = await db
    .select(shape)
    .from(comments)
    .where(where)
    .orderBy(desc(comments.id))
    .limit(200);
  if (tail.length < 200) return tail.reverse();
  // Capped: re-fetch EXACTLY the newest window in tree order - a bare
  // `asc limit 200` here would silently select the OLDEST 200 again (the very
  // bug this rewrite removes).
  const ordered = await db
    .select(shape)
    .from(comments)
    .where(and(where, inArray(comments.id, tail.map((r) => r.id))))
    .orderBy(asc(comments.id));
  return ordered;
}

export async function listPostCommentsCached(
  postId: number,
  postType = "post",
): Promise<Array<{
  id: number;
  parentId: number | null;
  authorName: string;
  authorEmail: string | null;
  authorUrl: string | null;
  content: string;
  createdAt: Date;
}>> {
  return memoQuery(`cmts:${postType}:${postId}`, SIDEBAR_TTL, () => listPostComments(postId, postType));
}

/** Comment listing for the public API / moderation front (live rows, asc). */
export async function listComments(opts: {
  postId?: number;
  postType?: string;
  parentId?: number;
  status?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}): Promise<{ items: Awaited<ReturnType<typeof listPostComments>>; total: number }> {
  const conds = [];
  if (opts.postId != null) conds.push(eq(comments.postId, opts.postId));
  if (opts.postType) conds.push(eq(comments.postType, opts.postType));
  if (opts.status) conds.push(eq(comments.status, opts.status as any));
  if (opts.parentId != null) conds.push(eq(comments.parentId, opts.parentId));
  const where = conds.length ? and(...conds) : undefined;
  const limit = Math.min(opts.limit ?? 200, 200);
  const offset = Math.max(0, opts.offset ?? 0);
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: comments.id,
        parentId: comments.parentId,
        authorName: comments.authorName,
        authorEmail: comments.authorEmail,
        authorUrl: comments.authorUrl,
        content: comments.content,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .where(where)
      .orderBy(opts.order === "desc" ? desc(comments.id) : asc(comments.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(comments).where(where),
  ]);
  return { items: rows, total: Number(totalRows[0]?.n ?? 0) };
}

/** R147: the comments feed's window - newest APPROVED comments on published
 * posts, each joined to its post in ONE round trip (feeds render rarely; a
 * per-comment getPostRow would be N+1). Pages are excluded (postType "post":
 * a page's comment thread is not what a reader subscribes to). The join IS
 * the moderation guarantee: pending/spam rows must never reach a public
 * syndication surface, and unpublished posts must not leak either. */
export type CommentFeedItem = {
  id: number;
  authorName: string;
  content: string;
  createdAt: Date;
  post: { id: number; title: string; url: string };
};

export async function listCommentFeed(limit: number): Promise<CommentFeedItem[]> {
  const n = Math.min(Math.max(limit, 1), 100);
  const rows = await db
    .select({
      id: comments.id,
      postId: comments.postId,
      authorName: comments.authorName,
      content: comments.content,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(posts, eq(comments.postId, posts.id))
    .where(
      and(
        eq(comments.status, "published"),
        eq(comments.postType, "post"),
        eq(posts.status, "published"),
        publishedVisible,
      ),
    )
    .orderBy(desc(comments.id))
    .limit(n);
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.postId))];
  const cfg = await getPermalinkConfig();
  // R201: only id/slug/title are used to build the post link — never the body.
  // Selecting the whole row shipped content + body_plain per comment's post.
  const postRows = await db
    .select({ id: posts.id, slug: posts.slug, title: posts.title })
    .from(posts)
    .where(inArray(posts.id, ids));
  const byId = new Map(postRows.map((p) => [p.id, p]));
  const out: CommentFeedItem[] = [];
  for (const r of rows) {
    const p = byId.get(r.postId);
    if (!p) continue;
    out.push({
      id: r.id,
      authorName: r.authorName,
      content: r.content,
      createdAt: r.createdAt,
      post: { id: p.id, title: p.title, url: postUrlFor(cfg, p) },
    });
  }
  return out;
}

// ---------------------------------------------------------------- widgets

export async function counts() {
  return memoQuery("counts", SIDEBAR_TTL, async () => {
    // One round trip instead of four: every count is a scalar subquery, and
    // at Neon RTT (~300ms) each extra statement is real first-paint latency.
    const rows = await db.execute(sql`select
      (select count(*) from ${posts} where ${posts.status} = 'published' and (${posts.publishedAt} is null or ${posts.publishedAt} <= now())) as posts,
      (select count(*) from ${comments} where ${comments.status} = 'published') as comments,
      (select count(*) from ${tags}) as tags,
      (select count(*) from ${categories}) as categories`);
    const r = (Array.isArray(rows) ? rows : (rows as any).rows)[0] ?? {};
    return {
      posts: Number(r.posts ?? 0),
      comments: Number(r.comments ?? 0),
      tags: Number(r.tags ?? 0),
      categories: Number(r.categories ?? 0),
    };
  });
}

/** Sidebar "most popular": the floating pinned set, in float order (matches the baked widget). */
export async function popularPosts(limit = 5): Promise<PostView[]> {
  return memoQuery(`popular:${limit}`, SIDEBAR_TTL, async () => {
    const { items } = await listPosts({ status: "published", orderBy: "views", limit });
    return items;
  });
}

export async function randomPosts(limit = 20): Promise<PostView[]> {
  // random() is uncacheable inside listPosts by design, so a per-view random
  // widget paid a full scan + hydrate on every render (the render cache is
  // per-cookie, so on every visitor). Rotate the pool on the sidebar TTL
  // instead: still fresh enough to feel random, one query per window.
  return memoQuery(`rand:${limit}`, SIDEBAR_TTL, async () => {
    const { items } = await listPosts({ status: "published", random: true, pinned: false, limit });
    return items;
  });
}

/** Published posts grouped by year/month for the archives timeline. */
export async function archiveGroups(): Promise<
  { year: number; months: { month: number; count: number }[]; total: number }[]
> {
  return memoQuery("archive", SIDEBAR_TTL, async () => {
    const rows = await db.execute(
      sql`SELECT EXTRACT(YEAR FROM ${posts.publishedAt})::int AS y,
               EXTRACT(MONTH FROM ${posts.publishedAt})::int AS m,
               count(*)::int AS n
        FROM ${posts}
        WHERE ${posts.status} = 'published' AND ${posts.publishedAt} IS NOT NULL
          AND ${posts.publishedAt} <= now()
        GROUP BY y, m
        ORDER BY y DESC, m DESC`,
    );
    const list = (Array.isArray(rows) ? rows : (rows as any).rows) as {
      y: number;
      m: number;
      n: number;
    }[];
    const byYear = new Map<number, { year: number; months: any[]; total: number }>();
    for (const r of list) {
      const g = byYear.get(r.y) ?? { year: r.y, months: [], total: 0 };
      g.months.push({ month: r.m, count: r.n });
      g.total += r.n;
      byYear.set(r.y, g);
    }
    return [...byYear.values()];
  });
}

/**
 * The archives timeline's row set: title, date, format, views and permalink —
 * exactly the five fields the template prints.
 *
 * Deliberately NOT listPosts(): that pays two extra round trips to attach
 * taxonomies and metas the archive never renders, and its 100-row cap silently
 * truncated the 1000-row window the caller asked for. One query, one shape.
 */
export type ArchiveItem = {
  id: number;
  title: string;
  url: string;
  publishedAt: Date | null;
  format: string;
  views: number;
};

export async function archiveItems(
  opts: { year?: number; month?: number; limit?: number; offset?: number } = {},
): Promise<ArchiveItem[]> {
  const conditions: any[] = [eq(posts.status, "published"), publishedVisible];
  if (opts.year) conditions.push(sql`EXTRACT(YEAR FROM ${posts.publishedAt}) = ${opts.year}`);
  if (opts.month) conditions.push(sql`EXTRACT(MONTH FROM ${posts.publishedAt}) = ${opts.month}`);
  const rows = await db
    .select({
      id: posts.id,
      title: posts.title,
      slug: posts.slug,
      pinyinSlug: posts.pinyinSlug,
      initialSlug: posts.initialSlug,
      publishedAt: posts.publishedAt,
      createdAt: posts.createdAt,
      format: posts.format,
      views: posts.views,
    })
    .from(posts)
    .where(and(...conditions))
    .orderBy(desc(posts.publishedAt), desc(posts.createdAt))
    .limit(opts.limit ?? 1000)
    .offset(opts.offset ?? 0);
  const cfg = await getPermalinkConfig();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: postUrlFor(cfg, r),
    publishedAt: r.publishedAt,
    format: r.format,
    views: r.views,
  }));
}

// --------------------------------------------------------------- writes (B phase)

/** PV always +1; UV +1 once per (post, sha256(ip|ua)). Best effort.
 *
 * One round trip: the visitor INSERT rides a CTE and the UPDATE reads whether
 * it actually inserted (ON CONFLICT DO NOTHING → empty RETURNING for a repeat
 * visitor) to decide the unique_views increment. At Neon RTT two serial
 * statements per pageview are real latency.
 *
 * `referrer` (db/migrations/0041) is OPTIONAL and purely additive: the two new
 * columns ride the SAME INSERT, so the statement count is unchanged, and the UV
 * decision still reads `exists (select 1 from ins)` untouched.
 *
 * The two "no data" shapes are deliberately different:
 *   - omit `referrer` entirely  -> both columns null. This is the pre-0041
 *     behaviour, kept for every existing caller (themes, scripts, imports).
 *   - pass `referrer` with no usable host ("" / garbage) -> kind 'direct',
 *     host null. "The visitor arrived with no referrer" IS the data.
 *
 * Only the HOST is stored; see referrer.ts for why the URL never reaches the
 * database. The site's own host comes from site-origin's remembered origin, so
 * an in-site navigation is recorded as 'internal' rather than credited to the
 * page's own domain as an external source.
 */
export async function incrementViews(
  id: number,
  ip: string,
  ua: string,
  referrer?: string,
): Promise<void> {
  if (ip || ua) {
    const key = createHash("sha256").update(`${ip}|${ua}`).digest("hex");
    const host = referrer === undefined ? null : referrerHostOf(referrer) || null;
    const kind = referrer === undefined ? null : classifyReferrer(referrer, ownHost());
    try {
      await db.execute(sql`
        with ins as (
          insert into ${postVisitors} ("post_id", "visitor_key", "referrer_host", "referrer_kind")
          values (${id}, ${key}, ${host}, ${kind})
          on conflict do nothing
          returning "post_id"
        )
        update ${posts}
        set views = views + 1,
            unique_views = unique_views + case when exists (select 1 from ins) then 1 else 0 end
        where id = ${id}`);
      return;
    } catch (e) {
      // Only a *query* failure means "not a new visitor". A dropped connection
      // says nothing about the visitor, and treating it as one sends the
      // else-branch UPDATE down the same dead socket. Rethrow so it is not
      // silently miscounted; the caller already treats view counting as
      // best-effort and swallows it.
      if (e instanceof Error && isConnectionError(e)) throw e;
      // Non-connection failure (e.g. a race on the CTE): fall through to the
      // plain PV increment below rather than losing the view entirely.
    }
  }
  await db.execute(sql`update ${posts} set views = views + 1 where id = ${id}`);
}

/** Current view count for a post (public read used by the live counter). */
export async function getPostViews(id: number): Promise<number> {
  if (!Number.isInteger(id) || id <= 0) return 0;
  const [row] = await db
    .select({ views: posts.views })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1);
  return row?.views ?? 0;
}

// Post likes are NOT here: likePost/unlikePost/likesFor live in post-likes.ts,
// where a like is a deduped row per (post, visitor) instead of an unconditional
// `likes + 1` a second browser could farm. This module keeps reads only.
