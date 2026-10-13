/**
 * Read queries for the public site — ported from lib/services/posts.ts and
 * taxonomies.ts. Every function reads the LIVE database on demand; nothing is
 * baked. Sticky ordering merges plugin ids (posts.pinned hook) with the
 * native posts.pinned flag, exactly as posts.ts does.
 */
import { createHash } from "crypto";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "./db.js";
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
import { HOOKS, applyFilters } from "./hooks.js";

export type TaxRef = { id: number; name: string; slug: string; url: string; icon?: string | null };

export type PostView = Post & {
  url: string;
  author: { id: number; name: string; email: string } | null;
  categories: TaxRef[];
  tags: TaxRef[];
  /** Custom fields (post_metas); themes consume e.g. bluemix_card_theme. */
  metas: Record<string, string>;
};

export type PostQuery = {
  status?: string;
  authorId?: number;
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
};

let settingsCache: { at: number; value: any } = { at: 0, value: null };

export async function getSettings(): Promise<Record<string, any>> {
  const now = Date.now();
  if (settingsCache.value && now - settingsCache.at < 30_000) return settingsCache.value;
  const rows = await db.select().from(siteSettings).limit(1);
  const value = rows[0] ?? {};
  settingsCache = { at: now, value };
  return value;
}

export function invalidateSettings(): void {
  settingsCache = { at: 0, value: null };
}

export async function attachTaxonomies(ids: number[]) {
  const cats: Record<number, { id: number; name: string; slug: string }[]> = {};
  const tg: Record<number, { id: number; name: string; slug: string }[]> = {};
  if (!ids.length) return { categories: cats, tags: tg };

  const ct = await db
    .select({ postId: postCategories.postId, id: categories.id, name: categories.name, slug: categories.slug })
    .from(postCategories)
    .innerJoin(categories, eq(postCategories.categoryId, categories.id))
    .where(inArray(postCategories.postId, ids));

  const tt = await db
    .select({ postId: postTags.postId, id: tags.id, name: tags.name, slug: tags.slug })
    .from(postTags)
    .innerJoin(tags, eq(postTags.tagId, tags.id))
    .where(inArray(postTags.postId, ids));

  for (const row of ct) (cats[row.postId] ??= []).push(row);
  for (const row of tt) (tg[row.postId] ??= []).push(row);
  return { categories: cats, tags: tg };
}

export async function listCategories(): Promise<Category[]> {
  const rows = await db.select().from(categories);
  return rows.sort(
    (a, b) =>
      (a.order ?? 0) - (b.order ?? 0) ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      a.id - b.id,
  );
}

export async function listTags(): Promise<Tag[]> {
  const rows = await db.select().from(tags);
  return rows.sort((a, b) => b.id - a.id);
}

export async function getCategoryBySlug(slug: string) {
  const rows = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function getTagBySlug(slug: string) {
  const rows = await db.select().from(tags).where(eq(tags.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function listPosts(
  opts: PostQuery = {},
): Promise<{ items: PostView[]; total: number }> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;
  const conditions: any[] = [];

  if (opts.status) conditions.push(eq(posts.status, opts.status as any));
  if (opts.authorId) conditions.push(eq(posts.authorId, opts.authorId));
  if (opts.categorySlug)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${postCategories} pc JOIN ${categories} c ON c.id = pc.category_id WHERE pc.post_id = ${posts.id} AND c.slug = ${opts.categorySlug})`,
    );
  if (opts.tagSlug)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${postTags} pt JOIN ${tags} t ON t.id = pt.tag_id WHERE pt.post_id = ${posts.id} AND t.slug = ${opts.tagSlug})`,
    );
  if (opts.search)
    conditions.push(
      sql`(${posts.title} ILIKE ${"%" + opts.search + "%"} OR ${posts.excerpt} ILIKE ${"%" + opts.search + "%"})`,
    );
  if (opts.year) conditions.push(sql`EXTRACT(YEAR FROM ${posts.publishedAt}) = ${opts.year}`);
  if (opts.month) conditions.push(sql`EXTRACT(MONTH FROM ${posts.publishedAt}) = ${opts.month}`);
  if (opts.excludeId) conditions.push(sql`${posts.id} <> ${opts.excludeId}`);

  const where = conditions.length ? and(...conditions) : undefined;

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
      const valid = await db
        .select({ id: posts.id })
        .from(posts)
        .where(where ? and(where, inArray(posts.id, wanted)) : inArray(posts.id, wanted));
      const validSet = new Set(valid.map((r) => r.id));
      floatingIds = wanted.filter((id) => validSet.has(id));
    }
    const pinRows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(where ? and(where, eq(posts.pinned, true)) : eq(posts.pinned, true));
    for (const r of pinRows) {
      if (!floatingIds.includes(r.id)) floatingIds.push(r.id);
    }
  }
  const normalWhere = floatingIds.length
    ? where
      ? and(where, notInArray(posts.id, floatingIds))
      : notInArray(posts.id, floatingIds)
    : where;

  const order = opts.random
    ? [sql`random()`]
    : opts.orderBy === "views"
      ? [desc(posts.views), desc(posts.publishedAt)]
      : opts.orderBy === "likes"
        ? [desc(posts.likes), desc(posts.publishedAt)]
        : opts.orderBy === "comments"
          ? [desc(posts.commentsCount), desc(posts.publishedAt)]
          : [desc(posts.publishedAt), desc(posts.createdAt)];

  const rowShape = { post: posts, authorName: users.name, authorEmail: users.email, authorId: users.id };
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

  const normalRows: JoinedRow[] =
    normalLimit > 0
      ? await db
          .select(rowShape)
          .from(posts)
          .leftJoin(users, eq(posts.authorId, users.id))
          .where(normalWhere)
          .orderBy(...(order as any))
          .limit(normalLimit)
          .offset(normalOffset)
      : [];

  const rows = pinnedRows.concat(normalRows);

  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(posts)
    .where(where);
  const total = Number(totalRows[0]?.count ?? 0);

  const cfg = await getPermalinkConfig();
  const ids = rows.map((r) => r.post.id);
  const [tax, metaMap] = await Promise.all([attachTaxonomies(ids), attachPostMetas(ids)]);

  const items: PostView[] = rows.map((r) => ({
    ...r.post,
    url: postUrlFor(cfg, r.post),
    author: r.authorId ? { id: r.authorId, name: r.authorName!, email: r.authorEmail! } : null,
    categories: (tax.categories[r.post.id] ?? []).map((c) => ({ ...c, url: categoryUrlFor(cfg, c) })),
    tags: (tax.tags[r.post.id] ?? []).map((t) => ({ ...t, url: tagUrlFor(cfg, t) })),
    metas: metaMap[r.post.id] ?? {},
  }));

  return { items, total };
}

async function hydrate(row: { post: Post; authorName: string | null; authorEmail: string | null; authorId: number | null }) {
  const [cfg, tax, metas] = await Promise.all([
    getPermalinkConfig(),
    attachTaxonomies([row.post.id]),
    getPostMetas(row.post.id),
  ]);
  const item: PostView = {
    ...row.post,
    url: postUrlFor(cfg, row.post),
    author: row.authorId
      ? { id: row.authorId, name: row.authorName!, email: row.authorEmail! }
      : null,
    categories: (tax.categories[row.post.id] ?? []).map((c) => ({ ...c, url: categoryUrlFor(cfg, c) })),
    tags: (tax.tags[row.post.id] ?? []).map((t) => ({ ...t, url: tagUrlFor(cfg, t) })),
    metas,
  };
  return item;
}

/** Published post by stored slug, with pinyin/initial/id fallback for other permalink modes. */
export async function getPost(tail: string): Promise<PostView | null> {
  const cfg = await getPermalinkConfig();
  let row: { post: Post; authorName: string | null; authorEmail: string | null; authorId: number | null } | undefined;

  const fetchOne = async (condition: any) => {
    const rows = await db
      .select({ post: posts, authorName: users.name, authorEmail: users.email, authorId: users.id })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .where(and(eq(posts.status, "published"), condition))
      .limit(1);
    return rows[0];
  };

  if (cfg.postMode === "id" && /^\d+$/.test(tail)) {
    row = await fetchOne(eq(posts.id, Number(tail)));
  } else if (cfg.postMode === "pinyin") {
    row = await fetchOne(eq(posts.pinyinSlug, tail));
  } else if (cfg.postMode === "initial") {
    row = await fetchOne(eq(posts.initialSlug, tail));
  } else {
    row = await fetchOne(eq(posts.slug, tail));
    if (!row && /^\d+$/.test(tail)) row = await fetchOne(eq(posts.id, Number(tail)));
    if (!row) row = await fetchOne(eq(posts.pinyinSlug, tail));
    if (!row) row = await fetchOne(eq(posts.initialSlug, tail));
  }
  return row ? hydrate(row) : null;
}

export async function relatedPosts(post: PostView, n = 4): Promise<PostView[]> {
  const { items } = await listPosts({
    status: "published",
    pinned: false,
    excludeId: post.id,
    orderBy: "date",
    limit: n,
  });
  return items;
}

export async function relatedByTaxonomy(postId: number, limit = 4): Promise<PostView[]> {
  const [catRows, tagRows, cfg] = await Promise.all([
    db.select({ id: postCategories.categoryId }).from(postCategories).where(eq(postCategories.postId, postId)),
    db.select({ id: postTags.tagId }).from(postTags).where(eq(postTags.postId, postId)),
    getPermalinkConfig(),
  ]);
  const catIds = catRows.map((r: { id: number }) => r.id);
  const tagIds = tagRows.map((r: { id: number }) => r.id);
  if (!catIds.length && !tagIds.length) {
    const { items } = await listPosts({ status: "published", excludeId: postId, orderBy: "date", limit });
    return items;
  }
  const [byCat, byTag] = await Promise.all([
    catIds.length
      ? db.select({ postId: postCategories.postId }).from(postCategories).where(inArray(postCategories.categoryId, catIds))
      : Promise.resolve([] as { postId: number }[]),
    tagIds.length
      ? db.select({ postId: postTags.postId }).from(postTags).where(inArray(postTags.tagId, tagIds))
      : Promise.resolve([] as { postId: number }[]),
  ]);
  const score = new Map<number, number>();
  for (const r of byCat) {
    if (r.postId === postId) continue;
    score.set(r.postId, (score.get(r.postId) ?? 0) + 3);
  }
  for (const r of byTag) {
    if (r.postId === postId) continue;
    score.set(r.postId, (score.get(r.postId) ?? 0) + 2);
  }
  if (!score.size) {
    const { items } = await listPosts({ status: "published", excludeId: postId, orderBy: "date", limit });
    return items;
  }
  const candidateIds = [...score.keys()];
  const rows = await db
    .select({
      id: posts.id,
      title: posts.title,
      slug: posts.slug,
      publishedAt: posts.publishedAt,
      featuredImage: posts.featuredImage,
    })
    .from(posts)
    .where(and(eq(posts.status, "published"), inArray(posts.id, candidateIds)));
  const byId = new Map(rows.map((r: { id: number }) => [r.id, r]));
  return candidateIds
    .map((id: number) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => Boolean(r))
    .map((p) => ({ ...p, score: score.get(p.id) ?? 0 }))
    .sort((a, b) => b.score - a.score || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    .slice(0, limit)
    .map((p) => ({
      ...p,
      url: postUrlFor(cfg, p),
    })) as unknown as PostView[];
}

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

export async function counts() {
  const [pc, cc, tc, cc2] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(posts).where(eq(posts.status, "published")),
    db.select({ n: sql<number>`count(*)` }).from(comments).where(eq(comments.status, "published")),
    db.select({ n: sql<number>`count(*)` }).from(tags),
    db.select({ n: sql<number>`count(*)` }).from(categories),
  ]);
  return {
    posts: Number(pc[0]?.n ?? 0),
    comments: Number(cc[0]?.n ?? 0),
    tags: Number(tc[0]?.n ?? 0),
    categories: Number(cc2[0]?.n ?? 0),
  };
}

/** Sidebar "most popular": the floating pinned set, in float order (matches the baked widget). */
export async function popularPosts(limit = 5): Promise<PostView[]> {
  const { items } = await listPosts({ status: "published", orderBy: "views", limit });
  return items;
}

export async function randomPosts(limit = 20): Promise<PostView[]> {
  const { items } = await listPosts({ status: "published", random: true, pinned: false, limit });
  return items;
}

/** Published posts grouped by year/month for the archives timeline. */
export async function archiveGroups(): Promise<
  { year: number; months: { month: number; count: number }[]; total: number }[]
> {
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
}

/** PV always +1; UV +1 once per (post, sha256(ip|ua)). Best effort. */
export async function incrementViews(id: number, ip: string, ua: string): Promise<void> {
  let isNewVisitor = false;
  if (ip || ua) {
    const key = createHash("sha256").update(`${ip}|${ua}`).digest("hex");
    try {
      const inserted = await db
        .insert(postVisitors)
        .values({ postId: id, visitorKey: key })
        .onConflictDoNothing()
        .returning({ postId: postVisitors.postId });
      isNewVisitor = inserted.length > 0;
    } catch {
      isNewVisitor = false;
    }
  }
  if (isNewVisitor) {
    await db.execute(
      sql`update ${posts} set views = views + 1, unique_views = unique_views + 1 where id = ${id}`,
    );
  } else {
    await db.execute(sql`update ${posts} set views = views + 1 where id = ${id}`);
  }
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
