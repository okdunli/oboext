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
} from "drizzle-orm";
import { db, isConnectionError } from "./db.js";
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
import { uploadExists } from "./storage.js";
import { HOOKS, applyFilters } from "./hooks.js";
import { ServiceError } from "./errors.js";
import { invalidate, memoQuery, memoStrict, SIDEBAR_TTL } from "./cache.js";

// Scheduled publishing (time gate): a `published` post whose publishedAt is in the future is "scheduled" and hidden from every public read.
const publishedVisible = or(isNull(posts.publishedAt), lte(posts.publishedAt, sql`now()`));

// Nullable on purpose: a root category has parentId = null. A parentId pointing
export type TaxRef = { id: number; name: string; slug: string; url: string; icon?: string | null; parentId?: number | null };

export type PostView = Post & {
  url: string;
  author: { id: number; name: string; email: string } | null;
  categories: TaxRef[];
  tags: TaxRef[];
/** Custom fields (post_metas); themes consume e.g. bluemix_card_theme. */
  metas: Record<string, string>;
};

// on every render - a crawler walking the site turned one absent file into a
const warnedMissingCovers = new Set<string>();

function withUsableCover<T extends { featuredImage?: string | null }>(view: T): T {
  if (view.featuredImage && !uploadExists(view.featuredImage)) {
    if (!warnedMissingCovers.has(view.featuredImage)) {
      warnedMissingCovers.add(view.featuredImage);
      console.warn(
        `[queries] featured_image ${view.featuredImage} is missing on disk, rendering without a cover`,
      );
    }
    return { ...view, featuredImage: null };
  }
  return view;
}

export type PostQuery = {
  status?: string;
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

export async function listPostsRaw(
  opts: PostQuery = {},
): Promise<{ items: PostView[]; total: number }> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;
  const conditions: any[] = [];

  if (opts.status) conditions.push(eq(posts.status, opts.status as any));
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
          sql`(${posts.title} ILIKE ${"%" + t + "%"} ESCAPE '\\' OR ${posts.excerpt} ILIKE ${"%" + t + "%"} ESCAPE '\\' OR ${taxTermMatch(t)})`,
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
  const wholeQuery = ilikeEscape((opts.search ?? "").trim());
  const searchRank = searchTermsEsc.length
    ? [
        sql`(CASE
          WHEN ${posts.title} ILIKE ${"%" + wholeQuery + "%"} ESCAPE '\\' THEN 0
          WHEN ${sql.join(
            searchTermsEsc.map((t) => sql`${posts.title} ILIKE ${"%" + t + "%"} ESCAPE '\\'`),
            sql` OR `,
          )} THEN 1
          WHEN ${posts.excerpt} ILIKE ${"%" + wholeQuery + "%"} ESCAPE '\\' THEN 2
          WHEN ${sql.join([taxTermMatch(wholeQuery), ...searchTermsEsc.map(taxTermMatch)], sql` OR `)} THEN 3
          ELSE 4 END)`,
      ]
    : [];

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
  const postShape: typeof posts = opts.full
    ? posts
    : ({ ...getTableColumns(posts), content: sql<string>`''` } as typeof posts);
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
  const key = `lp:${JSON.stringify({ ...opts, limit: opts.limit ?? 20, offset: opts.offset ?? 0 })}`;
  return memoQuery(key, SIDEBAR_TTL, () => listPostsRaw(opts));
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
              sql`(${posts.title} ILIKE ${"%" + t + "%"} ESCAPE '\\' OR ${posts.excerpt} ILIKE ${"%" + t + "%"} ESCAPE '\\')`,
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

export async function hydrate(row: PostRow): Promise<PostView> {
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
  return row ? hydrate(row) : null;
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

/** Published comments for one content item, oldest first (tree order). */
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
  const rows = await db
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
    .where(
      and(
        eq(comments.postId, postId),
        eq(comments.postType, postType),
        eq(comments.status, "published"),
      ),
    )
    .orderBy(asc(comments.id))
    .limit(200);
  return rows;
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
  opts: { year?: number; month?: number; limit?: number } = {},
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
    .limit(opts.limit ?? 1000);
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
 * statements per pageview are real latency. */
export async function incrementViews(id: number, ip: string, ua: string): Promise<void> {
  if (ip || ua) {
    const key = createHash("sha256").update(`${ip}|${ua}`).digest("hex");
    try {
      await db.execute(sql`
        with ins as (
          insert into ${postVisitors} ("post_id", "visitor_key")
          values (${id}, ${key})
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

export async function likePost(id: number): Promise<number> {
  const [row] = await db
    .update(posts)
    .set({ likes: sql`likes + 1` })
    .where(eq(posts.id, id))
    .returning({ likes: posts.likes });
  if (!row) throw new Error("文章不存在");
  return row.likes;
}
