// Static pages service — ported from lib/services/pages.ts + metas.ts.
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lte,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db } from "./db.js";
import { pages as pagesTable, type Block, type Page } from "./schema.js";
import type { SessionUser } from "./auth.js";
import { can, requireCap, requireUser, ServiceError, slugify } from "./admin.js";
import { blocksToPlainText } from "./admin.js";
import { getPageMetas, setPageMetas } from "./metas.js";
import { getPermalinkConfig, pageUrlFor } from "./links.js";
import { captureRename } from "./redirects.js";
import { invalidateContentCaches, memoQuery, SIDEBAR_TTL } from "./cache.js";
import { snapshotRevision } from "./revisions.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { normalizeWindow } from "./queries.js";
import { recordAdminAction } from "./security-events.js";

export type PageView = Page & {
  url: string;
  metas: Record<string, string>;
};

export type PageInput = {
  title: string;
  slug?: string;
  excerpt?: string | null;
  content?: Block[];
  status?: "draft" | "published" | "archived";
  featuredImage?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string | null;
  commentStatus?: "open" | "closed";
  parentId?: number | null;
  /** Menu weight: lower sorts first in public page listings. */
  order?: number;
  publishedAt?: string | null;
  metas?: { key: string; value: string }[];
};

// --------------------------------------------------------------------- metas
// Custom fields live in server/metas.ts (shared with posts); see that module.

// ---------------------------------------------------------------- validation

function excerptFrom(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() + "…" : clean;
}

function clean(v: string | null | undefined): string | null {
  return v === undefined || v === null || v === "" ? null : v;
}

const STATUSES = ["draft", "published", "archived"] as const;

/** Whitelisted, normalized page fields accepted by create/update. */
type ValidatedPage = {
  title?: string;
  slug?: string;
  excerpt?: string;
  content?: Block[];
  status?: (typeof STATUSES)[number];
  publishedAt?: string | null;
  featuredImage?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string | null;
  commentStatus?: "open" | "closed";
  parentId?: number | null;
  order?: number;
  metas?: { key: string; value: string }[];
};

/** Mirror of pageInputSchema; throws ServiceError(422) on bad input. */
function validate(input: Partial<PageInput>): ValidatedPage {
  const out: ValidatedPage = {};
  if (input.title !== undefined) {
    const title = String(input.title ?? "").trim();
    if (!title) throw new ServiceError("标题不能为空", 422);
    if (title.length > 300) throw new ServiceError("标题过长", 422);
    out.title = title;
  }
  if (input.slug !== undefined) {
    const s = String(input.slug ?? "").slice(0, 200);
    if (s) out.slug = s;
  }
  if (input.excerpt !== undefined) {
    const s = String(input.excerpt ?? "");
    if (s.length > 500) throw new ServiceError("摘要过长", 422);
    out.excerpt = s;
  }
  if (input.content !== undefined) {
    if (!Array.isArray(input.content)) throw new ServiceError("正文区块格式不正确", 422);
    out.content = input.content;
  }
  // Form payloads can carry "" for an untouched enum field; the typed input
  // says union, runtime says string — normalize both sides.
  if (input.status !== undefined && input.status != null && String(input.status) !== "") {
    if (!STATUSES.includes(input.status as (typeof STATUSES)[number]))
      throw new ServiceError("状态不合法", 422);
    out.status = input.status;
  }
  if (input.publishedAt !== undefined) {
    if (input.publishedAt) {
      if (Number.isNaN(Date.parse(input.publishedAt)))
        throw new ServiceError("publishedAt 必须是合法的时间字符串", 422);
      out.publishedAt = input.publishedAt;
    } else {
      out.publishedAt = null;
    }
  }
  if (input.featuredImage !== undefined) {
    const s = String(input.featuredImage ?? "");
    if (s.length > 500) throw new ServiceError("特色图 URL 过长", 422);
    out.featuredImage = s || null;
  }
  for (const [k, max] of [
    ["seoTitle", 200],
    ["seoDescription", 300],
    ["seoKeywords", 500],
  ] as const) {
    if (input[k] !== undefined) {
      const s = String(input[k] ?? "");
      if (s.length > max) throw new ServiceError("SEO 字段过长", 422);
      (out as Record<string, unknown>)[k] = s || null;
    }
  }
  if (input.commentStatus !== undefined && input.commentStatus != null && String(input.commentStatus) !== "") {
    if (input.commentStatus !== "open" && input.commentStatus !== "closed")
      throw new ServiceError("评论状态不合法", 422);
    out.commentStatus = input.commentStatus;
  }
  if (input.parentId !== undefined) {
    if (input.parentId == null || (input.parentId as unknown) === "") {
      out.parentId = null;
    } else {
      const n = Number(input.parentId);
      if (!Number.isInteger(n) || n <= 0) throw new ServiceError("父页面 ID 不合法", 422);
      out.parentId = n;
    }
  }
  if (input.order !== undefined && input.order !== null) {
    const n = Number(input.order);
    // WordPress menu_order is a non-negative integer; 0 is the default.
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000)
      throw new ServiceError("排序值必须是 0 到 1000000 的整数", 422);
    out.order = n;
  }
  if (input.metas !== undefined) {
    if (!Array.isArray(input.metas)) throw new ServiceError("自定义字段格式不正确", 422);
    out.metas = input.metas
      .filter((m) => m && typeof m === "object")
      .map((m) => ({ key: String(m.key ?? ""), value: String(m.value ?? "") }));
  }
  return out;
}

async function takenSlugs(base: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: pagesTable.slug })
    .from(pagesTable)
    .where(sql`${pagesTable.slug} LIKE ${base + "%"}`);
  return new Set(rows.map((r) => r.slug));
}

export async function hydrate(row: Page): Promise<PageView> {
  // Memoized (SWR, SIDEBAR_TTL) under `pgh:` for the same reason the post
  // hydrate is: the metas read is per-render cost on every cold page view.
  // The status is part of the key — adminGetPage hydrates drafts, and a draft
  // must never be served to a public reader from a shared entry.
  return memoQuery(`pgh:${row.id}:${row.status}`, SIDEBAR_TTL, async () => {
    const [metas, cfg] = await Promise.all([getPageMetas(row.id), getPermalinkConfig()]);
    return { ...row, url: pageUrlFor(cfg, row), metas };
  });
}

// ------------------------------------------------------------------- public

/** Published page by stored slug (null when missing/unpublished). Memoized
 *  (SWR, SIDEBAR_TTL) under `pg:` for the same reason the taxonomy lookups are:
 *  the catch-all router resolves the slug on every render, so under the 1s
 *  public render cache an unmemoized read is a remote round trip every second.
 *  create/update/deletePage drop it, so an edit is visible at once. */
// Scheduled publishing (R240 symmetry): pages run the same gate as posts —
// status 'published' + a future publishedAt is still "scheduled", hidden from
// every guest read. SQL twin of queries.publishedVisible (that one is bound to
// the posts table, so pages get their own; publishedAt is nullable on both).
const publishedPageVisible = or(isNull(pagesTable.publishedAt), lte(pagesTable.publishedAt, sql`now()`));

export async function getPublishedPageRow(slug: string): Promise<Page | null> {
  return memoQuery<Page | null>(`pg:${slug}`, SIDEBAR_TTL, async () => {
    const [row] = await db
      .select()
      .from(pagesTable)
      .where(and(eq(pagesTable.slug, slug), eq(pagesTable.status, "published"), publishedPageVisible))
      .limit(1);
    return row ?? null;
  });
}

/** Published page by stored slug (null when missing/unpublished), fully
 *  hydrated (metas + url). The detail loader uses getPublishedPageRow +
 *  hydrate directly so the metas read rides its wave. */
export async function getPublishedPage(slug: string): Promise<PageView | null> {
  const row = await getPublishedPageRow(slug);
  return row ? hydrate(row) : null;
}

/** Public GET /api/pages parity: guests see published pages only. */
export async function listPublishedPages(f: { limit?: number; offset?: number; windowCap?: number } = {}): Promise<{
  items: (Page & { url: string })[];
  total: number;
}> {
  // R158: /api/pages is PUBLIC and passes Number(q.get(...)) straight in -
  // clamp through the shared helper (NaN limit used to reach .limit(NaN)).
  // R247: windowCap raises the ceiling for the sitemap/page directory only.
  const { limit, offset } = normalizeWindow(f, 20, f.windowCap);
  const where = and(eq(pagesTable.status, "published"), publishedPageVisible);
  const rows = await db
    .select()
    .from(pagesTable)
    .where(where)
    // Menu weight first (WordPress menu_order), then the previous recency
    // order. Every page defaults to 0, so an install that never touches the
    // field keeps today's ordering exactly.
    .orderBy(asc(pagesTable.order), desc(pagesTable.updatedAt))
    .limit(limit)
    .offset(offset);
  const [totalRows, cfg] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(pagesTable).where(where),
    getPermalinkConfig(),
  ]);
  return {
    items: rows.map((r) => ({ ...r, url: pageUrlFor(cfg, r) })),
    total: Number(totalRows[0]?.n ?? 0),
  };
}

/** Published page by id (null when missing/unpublished) — guest GET parity. */
export async function getPublishedPageById(id: number): Promise<PageView | null> {
  const [row] = await db
    .select()
    .from(pagesTable)
    .where(and(eq(pagesTable.id, id), eq(pagesTable.status, "published"), publishedPageVisible))
    .limit(1);
  return row ? hydrate(row) : null;
}

// -------------------------------------------------------------------- admin

/** Admin page list — all statuses, newest-updated first, like the original. */
export async function adminListPages(
  user: SessionUser | null,
  f: { status?: string; limit?: number; offset?: number; after?: string; sort?: string } = {},
): Promise<{ items: (Page & { url: string })[]; total: number; nextCursor?: string }> {
  requireCap(user, "content:read");
  // R158: same shared clamp (admin route, but a bad ?limit must 200 not 500).
  const { limit, offset } = normalizeWindow(f, 50);
  // R177: the menu-order view edits the tree by hand, so it reads in the same
  // order the public site serves and pages by offset instead of a timestamp
  // cursor (an edited weight would otherwise skip or repeat rows mid-crawl).
  const byOrder = f.sort === "order";
  const conditions = [];
  if (f.status) conditions.push(eq(pagesTable.status, f.status as any));
  // Keyset on (updated_at, id), same shape as adminListPosts: the timestamp
  // rides the cursor as the database's own text so microseconds survive.
  const cur = byOrder ? null : decodeCursor(f.after);
  const keyset = cur && cur.t != null;
  if (keyset && cur) {
    const boundary = sql`${cur.t}::timestamptz`;
    conditions.push(
      or(
        lt(pagesTable.updatedAt, boundary),
        and(eq(pagesTable.updatedAt, boundary), lt(pagesTable.id, cur.id)),
      ),
    );
  }
  const where = conditions.length ? and(...conditions) : undefined;
  // Rows, total count and permalink config are mutually independent - one
  // wave instead of rows -> (count + config).
  // R202: same rule as adminListPosts - the pages list renders title/slug/
  // status/order/date only, so the two whole-body columns stay out of the row
  // shape; the editor reads the real body from adminGetPage (single row).
  const rowsQ = db
    .select({
      page: {
        ...getTableColumns(pagesTable),
        content: sql<string>`''`,
        bodyPlain: sql<string>`NULL`,
      } as typeof pagesTable,
      updatedAtText: sql<string>`${pagesTable.updatedAt}::text`,
    })
    .from(pagesTable)
    .where(where)
    .orderBy(
      ...(byOrder
        ? [asc(pagesTable.order), asc(pagesTable.id)]
        : [desc(pagesTable.updatedAt), desc(pagesTable.id)]),
    )
    .limit(limit);
  const rowsP = keyset ? rowsQ : rowsQ.offset(offset);
  const [rows, totalRows, cfg] = await Promise.all([
    rowsP,
    db.select({ n: sql<number>`count(*)` }).from(pagesTable).where(where),
    getPermalinkConfig(),
  ]);
  const items = rows.map((r) => ({ ...r.page, url: pageUrlFor(cfg, r.page) }));
  const out: { items: typeof items; total: number; nextCursor?: string } = {
    items,
    total: Number(totalRows[0]?.n ?? 0),
  };
  if (!byOrder && rows.length === limit) {
    const last = rows[rows.length - 1];
    out.nextCursor = encodeCursor({ t: last.updatedAtText, id: last.page.id });
  }
  return out;
}

/** Editor read: any status, custom fields as an editable {key,value} array. */
export async function adminGetPage(
  user: SessionUser | null,
  id: number,
): Promise<PageView & { metaList: { key: string; value: string }[] }> {
  requireCap(user, "content:read");
  const [row] = await db.select().from(pagesTable).where(eq(pagesTable.id, id));
  if (!row) throw new ServiceError("页面不存在", 404);
  const v = await hydrate(row);
  return { ...v, metaList: Object.entries(v.metas).map(([key, value]) => ({ key, value })) };
}

function requirePageManager(user: SessionUser | null): SessionUser {
  // The original gates EVERY page write (including create) on update:any —
  // authors never manage pages, unlike posts. Guests get 401 first.
  const u = requireUser(user);
  if (!can(u.role, "content:update:any"))
    throw new ServiceError("仅编辑/管理员可管理页面", 403);
  return u;
}

export async function createPage(user: SessionUser | null, raw: Partial<PageInput>) {
  requirePageManager(user);
  const input = validate(raw);
  if (!input.title) throw new ServiceError("标题不能为空", 422);
  const content = input.content ?? [];
  const base = slugify(input.slug || input.title);
  const slug = await uniquePageSlug(base, null);
  const status = input.status ?? "draft";
  const excerpt =
    input.excerpt || excerptFrom(blocksToPlainText(content));

  const [row] = await db
    .insert(pagesTable)
    .values({
      title: input.title,
      slug,
      excerpt,
      content,
      status,
      featuredImage: input.featuredImage !== undefined ? input.featuredImage : null,
      seoTitle: input.seoTitle !== undefined ? clean(input.seoTitle) : null,
      seoDescription: input.seoDescription !== undefined ? clean(input.seoDescription) : null,
      seoKeywords: input.seoKeywords !== undefined ? clean(input.seoKeywords) : null,
      commentStatus: input.commentStatus ?? "open",
      parentId: input.parentId ?? null,
      order: input.order ?? 0,
      publishedAt: input.publishedAt
        ? new Date(input.publishedAt)
        : status === "published"
          ? new Date()
          : null,
    })
    .returning();
  if (input.metas) await setPageMetas(row.id, input.metas);
  await snapshotRevision("page", row.id, null, row);
  invalidateContentCaches();
  return adminGetPage(user, row.id);
}

async function uniquePageSlug(base: string, ignoreSlug: string | null): Promise<string> {
  const taken = await takenSlugs(base);
  if (ignoreSlug) taken.delete(ignoreSlug);
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n++;
  }
  return slug;
}

export async function updatePage(user: SessionUser | null, id: number, raw: Partial<PageInput>) {
  requirePageManager(user);
  const input = validate(raw);
  const existingRow = await db
    .select()
    .from(pagesTable)
    .where(eq(pagesTable.id, id))
    .limit(1);
  const existing = existingRow[0];
  if (!existing) throw new ServiceError("页面不存在", 404);
  await snapshotRevision("page", id, null, existing);

  let slug = existing.slug;
  if (input.slug && input.slug !== existing.slug) {
    slug = await uniquePageSlug(slugify(input.slug), existing.slug);
  }
  const content = input.content ?? (existing.content as Block[]);
  let publishedAt = existing.publishedAt;
  if (input.publishedAt !== undefined) {
    publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  } else if (input.status === "published" && !existing.publishedAt) {
    publishedAt = new Date();
  }

  await db
    .update(pagesTable)
    .set({
      title: input.title ?? existing.title,
      slug,
      excerpt:
        input.excerpt !== undefined
          ? input.excerpt || excerptFrom(blocksToPlainText(content))
          : existing.excerpt,
      content,
      status: input.status ?? existing.status,
      featuredImage:
        input.featuredImage !== undefined ? input.featuredImage : existing.featuredImage,
      seoTitle: input.seoTitle !== undefined ? clean(input.seoTitle) : existing.seoTitle,
      seoDescription:
        input.seoDescription !== undefined ? clean(input.seoDescription) : existing.seoDescription,
      seoKeywords:
        input.seoKeywords !== undefined ? clean(input.seoKeywords) : existing.seoKeywords,
      commentStatus: input.commentStatus ?? existing.commentStatus,
      parentId: input.parentId !== undefined ? input.parentId : existing.parentId,
      order: input.order !== undefined ? input.order : existing.order,
      publishedAt,
      updatedAt: new Date(),
    })
    .where(eq(pagesTable.id, id));

  // R193: same contract as updatePost — a page's URL is its slug, so a rename
  // has to claim the old path or the links to it start answering 404.
  if (slug !== existing.slug) {
    const cfg = await getPermalinkConfig();
    await captureRename(pageUrlFor(cfg, existing), pageUrlFor(cfg, { ...existing, slug }));
  }

  if (input.metas) await setPageMetas(id, input.metas);
  invalidateContentCaches();
  return adminGetPage(user, id);
}

export async function deletePage(user: SessionUser | null, id: number): Promise<{ id: number }> {
  const u = requirePageManager(user);
  const [existing] = await db.select({ id: pagesTable.id }).from(pagesTable).where(eq(pagesTable.id, id));
  if (!existing) throw new ServiceError("页面不存在", 404);
  await db.delete(pagesTable).where(eq(pagesTable.id, id));
  invalidateContentCaches();
  await recordAdminAction(u, "pages.delete", { id });
  return { id };
}

// Bulk sibling of the single-row writes above. Pages carry no authorId, so
// requirePageManager is the whole contract - editors/admins only, exactly
// like updatePage/deletePage. Mirrors bulkPosts' shape (one UPDATE/DELETE per
// action, never a loop) and its publish semantics (COALESCE keeps the first
// publish time).
export async function bulkPages(
  user: SessionUser | null,
  ids: number[],
  action: "publish" | "draft" | "archive" | "delete",
): Promise<{ affected: number }> {
  const u = requirePageManager(user);
  const cleanIds = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (!cleanIds.length) return { affected: 0 };
  if (action === "delete") {
    await db.delete(pagesTable).where(inArray(pagesTable.id, cleanIds));
  } else {
    const status = action === "publish" ? "published" : action === "archive" ? "archived" : "draft";
    await db
      .update(pagesTable)
      .set(
        action === "publish"
          ? { status, publishedAt: sql`COALESCE(${pagesTable.publishedAt}, now())`, updatedAt: new Date() }
          : { status, updatedAt: new Date() },
      )
      .where(inArray(pagesTable.id, cleanIds));
  }
  invalidateContentCaches();
  await recordAdminAction(u, action === "delete" ? "pages.bulk_delete" : "pages.bulk_status", {
    ids: cleanIds,
    action,
  });
  return { affected: cleanIds.length };
}
