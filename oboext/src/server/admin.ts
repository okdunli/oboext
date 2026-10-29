// Admin service layer + Web API helpers — ported from the original app (lib/services/{posts,comments,taxonomies,settings,users,dashboard}.ts).
import { and, asc, desc, eq, getTableColumns, gt, inArray, lt, or, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { invalidateContentCaches } from "./cache.js";
import {
  posts,
  pages,
  comments,
  categories,
  tags,
  postCategories,
  postTags,
  users,
  siteSettings,
  media,
  webmentions,
  commentStateEnum,
  type Block,
  type Role,
} from "./schema.js";
import {
  getSettings,
  invalidateSettings,
  listCategories as allCategories,
  listComments,
  listTags as allTags,
  ilikeEscape,
} from "./queries.js";
import { getPostMetas, setPostMetas } from "./metas.js";
import { pinyinSlug as pinyinSlugOf } from "./pinyin.js";
import { getPermalinkConfig, postUrlFor, categoryUrlFor, tagUrlFor } from "./links.js";
import { captureRename } from "./redirects.js";
import type { SessionUser } from "./auth.js";
import { hashPassword } from "./auth.js";
import { HOOKS, applyAsyncFilters, doAction } from "./hooks.js";
import { createLogger } from "./logger.js";
import { passwordError } from "./password-policy.js";
import { snapshotRevision } from "./revisions.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { v, parseOrThrow } from "./validate.js";
import { recordAdminAction } from "./security-events.js";
import { emitAdminEvent } from "./realtime.js";
import { DEFAULT_LOCALE } from "./i18n.js";
const log = createLogger("admin");

// --------------------------------------------------------------------- errors

// Re-exported for every existing importer; the class itself lives in
// errors.ts (leaf module) so auth.ts can throw it without a cycle.
export { ServiceError } from "./errors.js";
import { ServiceError } from "./errors.js";

// ------------------------------------------------------------------ RBAC etc.

type Capability =
  | "content:read"
  | "content:create"
  | "content:update:any"
  | "content:update:own"
  | "content:delete:any"
  | "content:delete:own"
  | "media:read"
  | "media:upload"
  | "taxonomy:manage"
  | "users:read"
  | "users:manage"
  | "settings:manage";

const MATRIX: Record<Role, Capability[]> = {
  admin: [
    "content:read", "content:create", "content:update:any", "content:update:own",
    "content:delete:any", "content:delete:own", "media:read", "media:upload", "taxonomy:manage",
    "users:read", "users:manage", "settings:manage",
  ],
  editor: [
    "content:read", "content:create", "content:update:any", "content:update:own",
    "content:delete:any", "content:delete:own", "media:read", "media:upload", "taxonomy:manage",
    "users:read",
  ],
  author: [
    "content:read", "content:create", "content:update:own", "content:delete:own",
    "media:read", "media:upload",
  ],
  subscriber: ["content:read"],
};

export function can(role: Role, cap: Capability): boolean {
  return MATRIX[role]?.includes(cap) ?? false;
}

function canModifyContent(role: Role, ownerId: number, currentUserId: number): boolean {
  if (can(role, "content:update:any")) return true;
  return ownerId === currentUserId && can(role, "content:update:own");
}

// ------------------------------------------------------------- Web API helpers

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function jsonFail(message: string, status = 400, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(headers ?? {}) },
  });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export async function readBody(req: Request): Promise<any> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    throw new ServiceError("请求体过大", 413);
  try {
    return await req.json();
  } catch {
    throw new ServiceError("请求体不是合法 JSON", 400);
  }
}

/** 401 unless logged in; returns the session user. */
export function requireUser(user: SessionUser | null): SessionUser {
  if (!user) throw new ServiceError("未认证", 401);
  return user;
}

export function requireCap(user: SessionUser | null, cap: Capability): SessionUser {
  const u = requireUser(user);
  if (!can(u.role, cap)) throw new ServiceError("权限不足", 403);
  return u;
}

/**
 * Wrap an API handler: lazy migrations, ServiceError/status mapping.
 *
 * `t` is the request translator (routes on the bilingual public surface
 * pass one). When present, a ServiceError carrying a catalog `key` is
 * rendered in the request's language and the generic 500 message follows
 * suit; without it every message stays Chinese, which is what the admin
 * and member-center surfaces want.
 */
export async function apiGate(
  fn: () => Promise<Response | unknown>,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): Promise<Response> {
  try {
    await ensureMigrations();
    const out = await fn();
    if (out instanceof Response) return out;
    return jsonOk(out ?? null);
  } catch (e) {
    if (e instanceof ServiceError) {
      const msg = t && e.key ? t(e.key, e.params) : e.message;
      return jsonFail(msg, e.status);
    }
    log.error("[admin api]", e);
    const detail =
      process.env.DEBUG_API_ERRORS === "true" && e instanceof Error ? `: ${e.message}` : "";
    return jsonFail((t ? t("api.err_internal") : "服务器内部错误") + detail, 500);
  }
}

// ---------------------------------------------------------------- text utils

export function slugify(input: string): string {
  const base = input
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "item";
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n++;
  }
  return slug;
}

function excerptFrom(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() + "…" : clean;
}

export function blocksToPlainText(blocks: Block[] | null | undefined): string {
  if (!blocks) return "";
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading":
        case "paragraph":
        case "quote":
          return "text" in b ? b.text : "";
        case "image":
          return b.alt || b.caption || "";
        case "code":
          return b.code;
        case "list":
          return b.items.join(" ");
        case "html":
          return b.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join(" ");
}

async function takenSlugs(base: string): Promise<Set<string>> {
  const rows = await db
    .select({ v: posts.slug })
    .from(posts)
    .where(sql`${posts.slug} LIKE ${base + "%"}`);
  return new Set(rows.map((r) => r.v));
}

/** Column values already taken under a `base%` prefix (for uniqueness checks). */
async function takenColumn(
  col: typeof posts.pinyinSlug | typeof posts.initialSlug,
  base: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ v: col })
    .from(posts)
    .where(sql`${col} LIKE ${base + "%"}`);
  return new Set(rows.map((r) => r.v).filter((v): v is string => !!v));
}

/**
 * Persisted pinyin / initials tails for `postMode` "pinyin" / "initial".
 *
 * Both columns are uniquely indexed, so each tail gets the same -2/-3
 * de-duplication the plain slug does. `exclude` carries the row's current
 * values so editing keeps a post's tail instead of re-deriving it.
 */
async function uniqueLinkTails(
  title: string,
  exclude: { pinyin?: string | null; initial?: string | null } = {},
): Promise<{ pinyinSlug: string; initialSlug: string }> {
  const pyBase = pinyinSlugOf(title, "full");
  const iniBase = pinyinSlugOf(title, "initial");
  const [pyTaken, iniTaken] = await Promise.all([
    takenColumn(posts.pinyinSlug, pyBase),
    takenColumn(posts.initialSlug, iniBase),
  ]);
  if (exclude.pinyin) pyTaken.delete(exclude.pinyin);
  if (exclude.initial) iniTaken.delete(exclude.initial);
  return {
    pinyinSlug: uniqueSlug(pyBase, pyTaken),
    initialSlug: uniqueSlug(iniBase, iniTaken),
  };
}

// --------------------------------------------------------------------- posts

async function attachTaxonomyIds(ids: number[]) {
  const cats: Record<number, number[]> = {};
  const tags: Record<number, number[]> = {};
  if (!ids.length) return { cats, tags };
  const ct = await db
    .select()
    .from(postCategories)
    .where(inArray(postCategories.postId, ids));
  const tt = await db
    .select()
    .from(postTags)
    .where(inArray(postTags.postId, ids));
  for (const r of ct) (cats[r.postId] ??= []).push(r.categoryId);
  for (const r of tt) (tags[r.postId] ??= []).push(r.tagId);
  return { cats, tags };
}

async function setTaxonomies(postId: number, categoryIds: number[], tagIds: number[]) {
  await db.delete(postCategories).where(eq(postCategories.postId, postId));
  await db.delete(postTags).where(eq(postTags.postId, postId));
  if (categoryIds.length)
    await db
      .insert(postCategories)
      .values(categoryIds.map((categoryId) => ({ postId, categoryId })));
  if (tagIds.length)
    await db.insert(postTags).values(tagIds.map((tagId) => ({ postId, tagId })));
}

export type PostListFilter = {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  after?: string;
  /** R281: filter by content language ("zh-CN" | "en"); absent = all. */
  locale?: string;
};

/** Admin post list — all statuses, joined author + taxonomy names. */
export async function adminListPosts(user: SessionUser, f: PostListFilter = {}) {
  requireCap(user, "content:read");
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;
  const conditions = [];
  if (f.status) conditions.push(eq(posts.status, f.status as any));
  // R281: language filter — only the locales the catalog speaks are legal.
  if (f.locale && (f.locale === "zh-CN" || f.locale === "en"))
    conditions.push(eq(posts.locale, f.locale));
  // authors only see their own content; editors/admins see everything
  if (!can(user.role, "content:update:any"))
    conditions.push(eq(posts.authorId, user.id));
  // user input, so the wildcards must be escaped (ilikeEscape + ESCAPE '\') like
  // every other search in the app - a raw `%` would match every row and `a_b`
  // would also match `axb`. R202: the body joins the match via body_plain, same
  // as the public search - "find the post where I wrote X" must answer the
  // same in the admin list as on the site.
  if (f.search) {
    const like = `%${ilikeEscape(f.search)}%`;
    conditions.push(
      sql`(${posts.title} ILIKE ${like} ESCAPE '\\' OR ${posts.excerpt} ILIKE ${like} ESCAPE '\\' OR ${posts.bodyPlain} ILIKE ${like} ESCAPE '\\')`,
    );
  }
  // Keyset window on (updated_at, id). The timestamp rides the cursor as the
  // database's own text form: timestamptz is microsecond precision and a JS
  // Date (milliseconds) would silently skip rows that share a millisecond.
  // When a cursor is present it replaces OFFSET entirely - mixing the two
  // would page from the wrong origin.
  const cur = decodeCursor(f.after);
  const keyset = cur && cur.t != null;
  if (keyset && cur) {
    const boundary = sql`${cur.t}::timestamptz`;
    conditions.push(
      or(
        lt(posts.updatedAt, boundary),
        and(eq(posts.updatedAt, boundary), lt(posts.id, cur.id)),
      ),
    );
  }
  const where = conditions.length ? and(...conditions) : undefined;

  // One wave: the row window, the total count and the taxonomy lookup tables
  // are mutually independent. Only attachTaxonomyIds needs the row ids, so it
  // forms the single dependent second step (the old shape chained four serial
  // awaits: rows -> count -> taxIds -> cat/tag/config).
  //
  // id DESC is the sort tiebreaker: updated_at is not unique, and a total
  // order is what makes the offset walk and the keyset walk return the same
  // sequence. The index in migration 0020 carries both columns so the planner
  // can still serve this order without a Sort node.
  // R202: the list UI renders title/slug/status/dates/views only - content and
  // body_plain (the two whole-body columns) are dead weight here, and at 50
  // rows x ~9 KB bodies the list loader shipped ~0.5 MB per load. Blank them
  // exactly as the public listPosts shape does; the editor gets the real body
  // from adminGetPost (single row).
  const rowsQ = db
    .select({
      post: { ...getTableColumns(posts), content: sql<string>`''`, bodyPlain: sql<string>`NULL` } as typeof posts,
      authorName: users.name,
      updatedAtText: sql<string>`${posts.updatedAt}::text`,
    })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .where(where)
    .orderBy(desc(posts.updatedAt), desc(posts.id))
    .limit(limit);
  const rowsP = keyset ? rowsQ : rowsQ.offset(offset);
  const totalP = db
    .select({ n: sql<number>`count(*)` })
    .from(posts)
    .where(where);
  const catRowsP = allCategories();
  const tagRowsP = allTags();
  const cfgP = getPermalinkConfig();

  // R163: the count does not depend on the row window, so it rides the opening
  // wave instead of forming a second serial leg. Only attachTaxonomyIds needs
  // the row ids, so it stays as the single dependent step.
  // [totalRows] - not totalRows: the count builder resolves to a ROW ARRAY, so
  // destructuring it whole left `totalRows?.n` undefined and `total` stuck at 0
  // on every admin posts list (the list rendered, the count silently lied).
  const [rows, [totalRows], catRows, tagRows, cfg] = await Promise.all([
    rowsP,
    totalP,
    catRowsP,
    tagRowsP,
    cfgP,
  ]);
  const tax = await attachTaxonomyIds(rows.map((r) => r.post.id));
  const catName = new Map(catRows.map((c) => [c.id, c]));
  const tagName = new Map(tagRows.map((t) => [t.id, t]));

  const items = rows.map((r) => ({
    ...r.post,
    authorName: r.authorName,
    url: postUrlFor(cfg, r.post),
    categories: (tax.cats[r.post.id] ?? []).map((id) => catName.get(id)).filter(Boolean),
    tags: (tax.tags[r.post.id] ?? []).map((id) => tagName.get(id)).filter(Boolean),
  }));
  const out: { items: typeof items; total: number; nextCursor?: string } = {
    items,
    total: Number(totalRows?.n ?? 0),
  };
  // A full page means there may be more rows; the cursor points at the last
  // row's own (updated_at, id), which is the exact resume point. A short page
  // is the end of the list and carries no cursor.
  if (rows.length === limit) {
    const last = rows[rows.length - 1];
    out.nextCursor = encodeCursor({ t: last.updatedAtText, id: last.post.id });
  }
  return out;
}

export async function adminGetPost(user: SessionUser, id: number) {
  requireCap(user, "content:read");
  const [row] = await db.select().from(posts).where(eq(posts.id, id));
  if (!row) throw new ServiceError("文章不存在", 404);
  if (!canModifyContent(user.role, row.authorId, user.id))
    throw new ServiceError("权限不足", 403);
  const [tax, metas, cfg, originalRows] = await Promise.all([
    attachTaxonomyIds([id]),
    getPostMetas(id),
    getPermalinkConfig(),
    // R283: the edit page shows the ORIGINAL's title + a link, not a bare id.
    row.translationOf
      ? db.select({ id: posts.id, title: posts.title, slug: posts.slug, locale: posts.locale }).from(posts).where(eq(posts.id, row.translationOf))
      : Promise.resolve([] as { id: number; title: string; slug: string; locale: string }[]),
  ]);
  const original = originalRows[0] ?? null;
  return {
    ...row,
    url: postUrlFor(cfg, row),
    categoryIds: tax.cats[id] ?? [],
    tagIds: tax.tags[id] ?? [],
    metas,

    metaList: Object.entries(metas).map(([key, value]) => ({ key, value })),
    // R283: pairing echo for the editor (title + editor URL of the original).
    translationOriginal: original
      ? { id: original.id, title: original.title, editHref: "/admin/posts/" + original.id, locale: original.locale }
      : null,
  };
}

type PostInput = {
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
  pinned?: boolean;
  /** R272: content language (i18n.ts LOCALES). Defaults to the site default. */
  locale?: string;
  /** R273: id of the post this row translates; opposite locale, admin-only. */
  translationOf?: number | null;
  format?: string;
  
  formatMeta?: Record<string, string>;
  template?: string | null;
  publishedAt?: string | null;
  authorId?: number;
  categoryIds?: number[];
  tagIds?: number[];
  /** Custom fields (post_metas); full-set replace, mirror pages.ts. */
  metas?: { key: string; value: string }[];
};

/** Validate the editor's custom-field array (mirror pages.ts validate). */
function normMetas(v: unknown): { key: string; value: string }[] {
  if (!Array.isArray(v)) throw new ServiceError("自定义字段格式不正确", 422);
  return v.map((m: any) => ({ key: String(m?.key ?? ""), value: String(m?.value ?? "") }));
}


function normFormatMeta(v: unknown): Record<string, string> {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v))
    throw new ServiceError("文章形式字段格式不正确", 422);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim();
    if (key) out[key.slice(0, 100)] = String(val ?? "");
  }
  return out;
}

function clean(v: string | null | undefined): string | null {
  return v === undefined || v === null || v === "" ? null : v;
}

function normIds(v: unknown): number[] {
  return Array.isArray(v)
    ? v.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
}

const POST_STATUSES = ["draft", "published", "archived"] as const;

function normBlocks(v: unknown): Block[] {
  if (!Array.isArray(v)) throw new ServiceError("内容格式不正确", 422);
  if (v.length > 2000) throw new ServiceError("内容块数量过多", 422);
  for (const b of v) {
    if (b === null || typeof b !== "object" || Array.isArray(b))
      throw new ServiceError("内容块格式不正确", 422);
  }
  return v as Block[];
}

function checkPostShape(input: Partial<PostInput>): void {
  if (input.title !== undefined && String(input.title).trim().length > 200)
    throw new ServiceError("标题长度不能超过 200 个字符", 422);
  if (input.slug != null && String(input.slug).length > 100)
    throw new ServiceError("别名长度不能超过 100 个字符", 422);
  if (input.status !== undefined && !POST_STATUSES.includes(input.status))
    throw new ServiceError("非法的文章状态", 422);
  if (
    input.commentStatus !== undefined &&
    input.commentStatus !== "open" &&
    input.commentStatus !== "closed"
  )
    throw new ServiceError("非法的评论开关状态", 422);
  if (input.publishedAt != null && Number.isNaN(Date.parse(String(input.publishedAt))))
    throw new ServiceError("发布时间格式不正确", 422);
  if (input.excerpt != null && String(input.excerpt).length > 2000)
    throw new ServiceError("摘要长度不能超过 2000 个字符", 422);
  if (input.seoTitle != null && String(input.seoTitle).length > 200)
    throw new ServiceError("SEO 标题长度不能超过 200 个字符", 422);
  if (input.seoDescription != null && String(input.seoDescription).length > 500)
    throw new ServiceError("SEO 描述长度不能超过 500 个字符", 422);
  if (input.seoKeywords != null && String(input.seoKeywords).length > 500)
    throw new ServiceError("SEO 关键词长度不能超过 500 个字符", 422);
  if (input.featuredImage != null && String(input.featuredImage).length > 500)
    throw new ServiceError("特色图片地址过长", 422);
  if (input.template != null && String(input.template).length > 100)
    throw new ServiceError("模板名称过长", 422);
  if (input.format != null && String(input.format).length > 50)
    throw new ServiceError("文章形式名称过长", 422);
  if (input.authorId != null) {
    const n = Number(input.authorId);
    if (!Number.isInteger(n) || n <= 0) throw new ServiceError("非法的作者账号", 422);
  }
}

/**
 * R273: validate a translation pair. `locale` is the row being written;
 * `translationOf` names its original. Rules:
 *   - the default locale IS the original: its column stays NULL (passing a
 *     target there is a 422, not a silent drop);
 *   - the target must exist and speak the OPPOSITE locale — a pair that
 *     agrees about its language is a duplicate, not a translation;
 *   - null unsets (unlink).
 * Returns null when the row must carry no pointer.
 */
async function resolveTranslationOf(locale: string, translationOf: number | null | undefined): Promise<number | null> {
  if (translationOf === undefined) return undefined as unknown as null;
  if (translationOf === null) return null;
  if (locale === DEFAULT_LOCALE) throw new ServiceError("默认语言文章自身即原文，不能指向翻译", 422);
  if (!Number.isInteger(translationOf) || translationOf <= 0) throw new ServiceError("非法的翻译目标", 422);
  const [target] = await db.select({ locale: posts.locale }).from(posts).where(eq(posts.id, translationOf));
  if (!target) throw new ServiceError("翻译目标不存在", 404);
  if (target.locale === locale) throw new ServiceError("翻译目标必须属于另一种语言", 422);
  return translationOf;
}

export async function createPost(user: SessionUser, input: PostInput) {  requireCap(user, "content:create");
  const title = (input.title || "").trim();
  if (!title) throw new ServiceError("标题不能为空", 422);
  checkPostShape(input);
  const content = Array.isArray(input.content) ? normBlocks(input.content) : [];
  const slugBase = slugify(input.slug || title);
  const slug = uniqueSlug(slugBase, await takenSlugs(slugBase));
  const tails = await uniqueLinkTails(title);
  const authorId =
    (user.role === "admin" || user.role === "editor") && input.authorId
      ? Number(input.authorId)
      : user.id;
  const status = input.status ?? "draft";
  const excerpt =
    input.excerpt || excerptFrom(blocksToPlainText(content));
  // R273: a paired translation must point ACROSS locales, and a default-locale
  // row is its own original (the column stays NULL for it).
  const locale = (input.locale ?? "zh-CN") as string;
  let translationOf = await resolveTranslationOf(locale, input.translationOf);
  // R282: auto-pairing. When a new NON-default post's requested slug collides
  // with an existing post in the OPPOSITE locale, the author almost certainly
  // translated it (same slug, other language) — link the pair automatically
  // unless the input named an explicit translationOf. The slug keeps its
  // `-2` uniquifier (URLs must stay distinct); only the pairing follows.
  let autoPairNote: string | undefined;
  if (
    translationOf == null &&
    locale !== DEFAULT_LOCALE &&
    !input.translationOf
  ) {
    const [candidate] = await db
      .select({ id: posts.id, slug: posts.slug })
      .from(posts)
      .where(and(eq(posts.slug, slugBase), eq(posts.locale, DEFAULT_LOCALE)));
    if (candidate && slug !== slugBase) {
      translationOf = candidate.id;
      autoPairNote = `已自动关联原文「${candidate.slug}」（同别名、中文原文）`;
    }
  }

  const [row] = await db
    .insert(posts)
    .values({
      title,
      slug,
      // Real romanised tails (the pinyin dictionary powers postMode
      // "pinyin"/"initial" and the {pinyin}/{initial} permalink tokens).
      pinyinSlug: tails.pinyinSlug,
      initialSlug: tails.initialSlug,
      excerpt,
      content,
      bodyPlain: blocksToPlainText(content),
      status,
      featuredImage: clean(input.featuredImage),
      seoTitle: clean(input.seoTitle),
      seoDescription: clean(input.seoDescription),
      seoKeywords: clean(input.seoKeywords),
      commentStatus: input.commentStatus ?? "open",
      authorId,
      publishedAt: input.publishedAt
        ? new Date(input.publishedAt)
        : status === "published"
          ? new Date()
          : null,
      format: (input.format as any) ?? "standard",
      formatMeta: normFormatMeta(input.formatMeta),
      pinned: input.pinned ?? false,
      template: clean(input.template),
      locale,
      translationOf,
    })
    .returning();
  await setTaxonomies(row.id, normIds(input.categoryIds), normIds(input.tagIds));
  if (input.metas) await setPostMetas(row.id, normMetas(input.metas));
  await snapshotRevision("post", row.id, authorId, row);
  invalidateContentCaches();
  // post.published: the outbound Webmention sender (and anything else that
  // wants "this just went live") listens here. doAction never awaits - the
  // handler is fire-and-forget by contract.
  if (row.status === "published") doAction(HOOKS.postPublished, { post: row });
  // R282: surface the auto-pair so the editor's UI can toast it.
  const created = await adminGetPost(user, row.id);
  return autoPairNote ? { ...created, autoPairNote } : created;
}

export async function updatePost(user: SessionUser, id: number, input: Partial<PostInput>) {
  const existing = await adminGetPost(user, id); // 404 + ownership
  checkPostShape(input);
  await snapshotRevision("post", id, user.id, existing);
  let slug = existing.slug;
  if (input.slug && input.slug !== existing.slug) {
    const base = slugify(input.slug);
    const taken = await takenSlugs(base);
    taken.delete(existing.slug);
    slug = uniqueSlug(base, taken);
  }
  const content = input.content ?? (existing.content as Block[]);
  // Re-derive the romanised tails only when the title changes; otherwise the
  // columns are left out of the SET entirely, so a row keeps its values (NULL
  // included — pre-pinyin rows never had them).
  const nextTitle = input.title ?? existing.title;
  const tails =
    input.title !== undefined && input.title !== existing.title
      ? await uniqueLinkTails(nextTitle, {
          pinyin: existing.pinyinSlug,
          initial: existing.initialSlug,
        })
      : null;
  let publishedAt = existing.publishedAt;
  if (input.publishedAt) publishedAt = new Date(input.publishedAt);
  else if (input.status === "published" && !existing.publishedAt) publishedAt = new Date();
  // only admins/editors may reassign authorship; authors keep themselves
  const authorId =
    input.authorId != null && can(user.role, "content:update:any")
      ? Number(input.authorId)
      : existing.authorId;

  await db
    .update(posts)
    .set({
      title: input.title ?? existing.title,
      authorId,
      slug,
      ...(tails ? { pinyinSlug: tails.pinyinSlug, initialSlug: tails.initialSlug } : {}),
      excerpt:
        input.excerpt !== undefined
          ? input.excerpt || excerptFrom(blocksToPlainText(content))
          : existing.excerpt,
      content,
      bodyPlain: blocksToPlainText(content),
      status: input.status ?? existing.status,
      featuredImage:
        input.featuredImage !== undefined
          ? clean(input.featuredImage)
          : existing.featuredImage,
      seoTitle: input.seoTitle !== undefined ? clean(input.seoTitle) : existing.seoTitle,
      seoDescription:
        input.seoDescription !== undefined ? clean(input.seoDescription) : existing.seoDescription,
      seoKeywords:
        input.seoKeywords !== undefined ? clean(input.seoKeywords) : existing.seoKeywords,
      commentStatus: input.commentStatus ?? existing.commentStatus,
      publishedAt,
      format: (input.format as any) ?? existing.format,
      
      formatMeta:
        input.formatMeta !== undefined ? normFormatMeta(input.formatMeta) : existing.formatMeta,
      pinned: input.pinned !== undefined ? input.pinned : existing.pinned,
      template: input.template !== undefined ? clean(input.template) : existing.template,
      locale: input.locale ?? existing.locale,
      translationOf:
        input.translationOf !== undefined
          ? await resolveTranslationOf(input.locale ?? existing.locale, input.translationOf)
          : existing.translationOf,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, id));

  // R193: a post's public URL is derived from its slug, never stored, so a
  // rename is otherwise a silent delete of every link that already points at
  // the old one — including the ones search engines have indexed. Claim the
  // old path here and point it at the new one (permanent: a rename is not a
  // temporary move). Never blocks or fails the save; captureRename swallows.
  if (slug !== existing.slug) {
    const cfg = await getPermalinkConfig();
    await captureRename(postUrlFor(cfg, existing), postUrlFor(cfg, { ...existing, slug }));
  }

  if (input.categoryIds || input.tagIds)
    await setTaxonomies(id, normIds(input.categoryIds), normIds(input.tagIds));
  if (input.metas !== undefined) await setPostMetas(id, normMetas(input.metas));
  invalidateContentCaches();
  // post.published fires on the TRANSITION only (draft -> published), not on
  // every save of an already-live post: an editor fixing a typo must not
  // re-notify every link in the article. The row is re-read rather than
  // reconstructed because the sender needs the STORED body (and its id/slug),
  // which the patch may not have carried.
  if (existing.status !== "published") {
    const [fresh] = await db.select().from(posts).where(eq(posts.id, id));
    if (fresh && fresh.status === "published") doAction(HOOKS.postPublished, { post: fresh });
  }
  return adminGetPost(user, id);
}

export async function deletePost(user: SessionUser, id: number) {
  const existing = await adminGetPost(user, id);
  if (!canModifyContent(user.role, existing.authorId, user.id))
    throw new ServiceError("权限不足", 403);
  // hard delete like the original; comments have no FK and are left behind
  await db.delete(posts).where(eq(posts.id, id));
  invalidateContentCaches();
  await recordAdminAction(user, "posts.delete", { id });
  return { id };
}

export const BULK_CONTENT_ACTIONS = ["publish", "draft", "archive", "delete"] as const;
export type BulkContentAction = (typeof BULK_CONTENT_ACTIONS)[number];

// One whitelist for every bulk content route (posts, pages). The posts route
// used to pass the raw body string straight into bulkPosts, whose else-branch
// defaults to "draft" — so a typo ("publsh") or a junk value silently
// mass-drafted the selection instead of failing. Unknown action -> null.
export function parseBulkAction(raw: unknown): BulkContentAction | null {
  return typeof raw === "string" && (BULK_CONTENT_ACTIONS as readonly string[]).includes(raw)
    ? (raw as BulkContentAction)
    : null;
}

export async function bulkPosts(
  user: SessionUser | null,
  ids: number[],
  action: "publish" | "draft" | "archive" | "delete",
) {
  // 401 for guests; per-row ownership filtering still applies below.
  const u = requireUser(user);
  const rows = await db
    .select({ id: posts.id, authorId: posts.authorId })
    .from(posts)
    .where(inArray(posts.id, ids));
  const allowed = rows.filter((p) => canModifyContent(u.role, p.authorId, u.id));
  if (!allowed.length) return { affected: 0 };
  const allowedIds = allowed.map((p) => p.id);
  // Which of these rows are transitioning INTO published? Captured before the
  // UPDATE, which is the only moment the "was it already live?" answer exists.
  let justPublished: typeof allowed = [];
  if (action === "publish") {
    const live = new Set(
      (
        await db
          .select({ id: posts.id, status: posts.status })
          .from(posts)
          .where(inArray(posts.id, allowedIds))
      )
        .filter((r) => r.status === "published")
        .map((r) => r.id),
    );
    justPublished = allowed.filter((p) => !live.has(p.id));
  }
  if (action === "delete") {
    await db.delete(posts).where(inArray(posts.id, allowedIds));
  } else {
    const status = action === "publish" ? "published" : action === "archive" ? "archived" : "draft";
    await db
      .update(posts)
      .set(
        action === "publish"
          ? { status, publishedAt: sql`COALESCE(${posts.publishedAt}, now())`, updatedAt: new Date() }
          : ({ status, updatedAt: new Date() } as any),
      )
      .where(inArray(posts.id, allowedIds));
  }
  invalidateContentCaches();
  // Same contract as updatePost: post.published fires on the transition only,
  // and each row carries its STORED body so the sender can scan the real links.
  if (justPublished.length) {
    const fresh = await db
      .select()
      .from(posts)
      .where(inArray(posts.id, justPublished.map((p) => p.id)));
    for (const row of fresh) doAction(HOOKS.postPublished, { post: row });
  }
  await recordAdminAction(u, action === "delete" ? "posts.bulk_delete" : "posts.bulk_status", {
    ids: allowedIds,
    action,
  });
  return { affected: allowedIds.length };
}

// ------------------------------------------------------------------ comments

async function bumpCommentCount(postType: string, postId: number, delta: number) {
  const t = postType === "page" ? pages : posts;
  await db
    .update(t)
    .set({ commentsCount: sql`${t.commentsCount} + ${delta}` })
    .where(eq(t.id, postId));
}

export async function adminListComments(
  user: SessionUser,
  f: { status?: string; limit?: number; offset?: number; after?: string } = {},
) {
  requireCap(user, "content:read");
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;
  const conditions = [];
  if (f.status) conditions.push(eq(comments.status, f.status as any));
  // Keyset on id: the primary key already provides the order, so the cursor
  // is a bare id with no timestamp to round-trip.
  const cur = decodeCursor(f.after);
  const keyset = !!cur;
  if (cur) conditions.push(lt(comments.id, cur.id));
  const where = conditions.length ? and(...conditions) : undefined;

  const rowsQ = db
    .select()
    .from(comments)
    .where(where)
    .orderBy(desc(comments.id))
    .limit(limit);
  // R163: the count never depended on the row window, so it rides the opening
  // wave. Titles are the one dependent step and are split by postType (posts
  // and pages share the id space, so a bare postId map would let a page
  // comment inherit a same-numbered post's title) - two queries in one wave,
  // never one query per comment.
  const [rows, [totalRows]] = await Promise.all([
    keyset ? rowsQ : rowsQ.offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(comments).where(where),
  ]);
  const titles = new Map<string, string>();
  const postIds = [...new Set(rows.filter((r) => r.postType !== "page").map((r) => r.postId))];
  const pageIds = [...new Set(rows.filter((r) => r.postType === "page").map((r) => r.postId))];
  const [pRows, gRows] = await Promise.all([
    postIds.length
      ? db.select({ id: posts.id, title: posts.title }).from(posts).where(inArray(posts.id, postIds))
      : Promise.resolve([] as { id: number; title: string }[]),
    pageIds.length
      ? db.select({ id: pages.id, title: pages.title }).from(pages).where(inArray(pages.id, pageIds))
      : Promise.resolve([] as { id: number; title: string }[]),
  ]);
  for (const r of pRows) titles.set(`post:${r.id}`, r.title);
  for (const r of gRows) titles.set(`page:${r.id}`, r.title);
  const items = rows.map((c) => ({
    ...c,
    postTitle: titles.get(`${c.postType}:${c.postId}`) ?? "（已删除）",
  }));
  const out: { items: typeof items; total: number; nextCursor?: string } = {
    items,
    total: Number(totalRows?.n ?? 0),
  };
  if (rows.length === limit) {
    out.nextCursor = encodeCursor({ id: rows[rows.length - 1].id });
  }
  return out;
}

/**
 * Public GET /api/comments parity: guests see published comments only;
 * editors/admins may pass status=pending|spam (or omit it to see all).
 */
export async function publicListComments(
  user: SessionUser | null,
  q: { post?: string | null; postType?: string | null; parent?: string | null; status?: string | null },
) {
  const isMod = !!user && can(user.role, "content:update:any");
  const status = q.status || undefined;
  if (status && status !== "published" && !isMod) {
    throw new ServiceError("未认证", 401);
  }
  // Post threads read oldest-first (tree order); an unscoped moderator view
  // is an admin listing, so newest-first (and newest rows survive the cap).
  const scoped = !!q.post;
  const { items, total } = await listComments({
    postId: q.post ? Number(q.post) : undefined,
    postType: q.postType || "post",
    parentId: q.parent ? Number(q.parent) : undefined,
    status: isMod ? status : "published",
    order: scoped ? "asc" : "desc",
  });
  return { items, total };
}

function normHost(h: string): string {
  return h
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0]
    .replace(/^www\./, "");
}

/** Anti-impersonation, ported from comments.ts: guests can't use staff identity. */
async function assertNotImpersonation(input: {
  authorName: string;
  authorEmail?: string | null;
  authorUrl?: string | null;
  siteHost?: string | null;
}) {
  const settings = await getSettings();
  const admins = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.role, "admin"));
  const names = new Set<string>();
  const emails = new Set<string>();
  for (const v of [settings.siteTitle, settings.tagline]) {
    if (v) names.add(String(v).toLowerCase());
  }
  for (const a of admins) {
    if (a.name) names.add(a.name.toLowerCase());
    if (a.email) emails.add(a.email.toLowerCase());
  }
  const name = input.authorName.trim().toLowerCase();
  if (name && names.has(name))
    throw new ServiceError("不允许使用管理员或本站身份作为昵称", 403);
  const email = (input.authorEmail ?? "").trim().toLowerCase();
  if (email && emails.has(email))
    throw new ServiceError("不允许使用管理员或本站的邮箱", 403);
  if (input.siteHost && input.authorUrl) {
    if (normHost(input.authorUrl) === normHost(input.siteHost))
      throw new ServiceError("不允许填写本站网址", 403);
  }
}

export type PublicCommentInput = {
  postId: number;
  postType?: string;
  parentId?: number | null;
  authorName?: string;
  authorEmail?: string | null;
  authorUrl?: string | null;
  content: string;
  /** logged-in submitter, if any */
  user?: SessionUser | null;
  ip?: string | null;
  siteHost?: string | null;
  /**
   * A Webmention (server.ts) rather than a person at the comment form. The
   * author identity is scraped from the source page, so there is no email to
   * ask for and nobody to fix a missing one: the name+email requirement is
   * skipped and the verdict is forced to `pending` (a human moderates scraped
   * content, and an auto-approved mention is a spam hole).
   */
  viaWebmention?: boolean;
};

/**
 * Does any moderation blocklist word appear in the comment haystack?
 * Case-insensitive on both sides: a case-sensitive substring match is trivially
 * bypassed ("spam" -> "SPAM"), which defeats a blocklist. Pure + exported so the
 * matching rule is unit-testable without a database.
 */
export function moderationFlags(haystack: string, wordsRaw: string | undefined | null): boolean {
  const words = String(wordsRaw ?? "")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) return false;
  const lower = haystack.toLowerCase();
  return words.some((w) => lower.includes(w));
}

export async function createPublicComment(input: PublicCommentInput) {
  const postType = input.postType ?? "post";
  const t = postType === "page" ? pages : posts;
  const [parent] = await db
    .select({ commentStatus: t.commentStatus, title: t.title })
    .from(t)
    .where(eq(t.id, input.postId));
  if (!parent) throw new ServiceError("内容不存在", 404, "api.comment_missing");

  // A reply must point at a real comment ON THE SAME content. The route coerces
  // parentId with Number(), which yields NaN for junk (NaN ?? null stays NaN and
  // would be written to an integer column), and nothing stopped a parentId from
  // another post - orphaning the reply into the wrong thread. Validate at the
  // trust boundary: positive integer, and the parent exists for this post+type.
  let parentId: number | null = null;
  if (input.parentId != null) {
    if (!Number.isInteger(input.parentId) || input.parentId < 1) {
      throw new ServiceError("父评论不存在", 422, "api.comment_missing");
    }
    const [pc] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.id, input.parentId),
          eq(comments.postId, input.postId),
          eq(comments.postType, postType),
        ),
      )
      .limit(1);
    if (!pc) throw new ServiceError("父评论不存在", 422, "api.comment_missing");
    parentId = input.parentId;
  }

  const settings = await getSettings();
  let isStaff = false;
  if (input.user) {
    const [u] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, input.user.id));
    isStaff = Boolean(u && u.role !== "subscriber");
  }
  if (!settings.commentsEnabled && !isStaff)
    throw new ServiceError("评论已关闭", 403, "api.comment_closed");
  if (parent.commentStatus === "closed" && !isStaff)
    throw new ServiceError("本文评论已关闭", 403, "api.comment_post_closed");

  const content = (input.content || "").trim();
  if (!content) throw new ServiceError("评论内容不能为空", 422, "api.comment_empty");
  if (content.length > 5000) throw new ServiceError("评论内容过长", 422, "api.comment_too_long");

  let authorName = input.authorName?.trim() || "匿名";
  let authorEmail = input.authorEmail ?? null;
  let authorUrl = input.authorUrl ?? null;
  let userId: number | null = null;
  // R147: did the identity below come from the DB (logged-in override) rather
  // than from guest-submitted fields? Only then may the blocklist check step
  // aside - see the branch comments.
  let identityFromDb = false;

  // logged-in identity overrides submitted guest fields (no impersonation)
  if (input.user) {
    const [u] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, input.user.id));
    if (u) {
      authorName = u.name;
      authorEmail = u.email;
      userId = input.user.id;
      identityFromDb = true;
    }
  } else {
    // A Webmention carries no email by construction (the identity is scraped
    // from the source page, nobody is present to supply one), so the
    // name+email requirement would refuse every legitimate mention on a site
    // that enabled it. The link requirement still holds - a mention always
    // has a source URL.
    if (
      !input.viaWebmention &&
      settings.requireNameEmail &&
      (!input.authorName?.trim() || !input.authorEmail?.trim())
    )
      throw new ServiceError("请填写昵称和邮箱", 422, "api.comment_name_email");
    // The link is required on its own switch, not as part of the name+email
    // pair. Enforced here rather than only in the browser: the field is a
    // placeholder hint client-side, and a POST that skips it must not slip past.
    if (settings.requireAuthorUrl && !input.authorUrl?.trim())
      throw new ServiceError("请填写链接", 422, "api.comment_url");
  }

  if (identityFromDb) {
    // R147 FIX: the old unconditional assertNotImpersonation() below ran AFTER
    // the logged-in override, so it compared the author's own (staff) name and
    // email against a blocklist that CONTAINS them (siteTitle/tagline/all
    // admin names+emails) - every admin with a non-empty display name got 403
    // "不允许使用管理员或本站身份" and could never comment on their own blog.
    // Identity fields here are SERVER-derived (the override above IS the
    // anti-impersonation); only the guest URL field survives untouched, so the
    // site-URL rule is the one that still applies.
    if (input.siteHost && authorUrl) {
      if (normHost(authorUrl) === normHost(input.siteHost)) {
        throw new ServiceError("不允许填写本站网址", 403);
      }
    }
  } else {
    // Guest-supplied identity: staff/site identity must never be borrowed.
    await assertNotImpersonation({ authorName, authorEmail, authorUrl, siteHost: input.siteHost });
  }

  // Flood backstop: when captcha is off and moderation is off, nothing else
  // bounds how fast one IP can POST comments (the arithmetic captcha is
  // trivially machine-solvable, so it is not a volume gate). Count recent
  // submissions from this IP in a window and refuse past a generous, env-tunable
  // cap - high enough that a shared NAT never trips it, low enough to stop a
  // flood. Staff are exempt (trusted, and bulk curation must not stall).
  if (input.ip && !isStaff) {
    const max = Math.max(1, Number(process.env.OBOEXT_COMMENT_RATE_MAX) || 20);
    const windowMin = Math.max(1, Number(process.env.OBOEXT_COMMENT_RATE_WINDOW_MIN) || 10);
    const windowMs = windowMin * 60_000;
    const [recent] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(eq(comments.ip, input.ip), gt(comments.createdAt, new Date(Date.now() - windowMs))));
    if ((recent?.n ?? 0) >= max) {
      throw new ServiceError("评论过于频繁，请稍后再试", 429, "api.comment_rate_limited");
    }
  }

  const haystack = [content, authorName, authorEmail ?? "", authorUrl ?? ""].join("\n");
  let status: "published" | "pending" | "spam" = "published";
  // A webmention is scraped content from a machine: it always starts pending,
  // regardless of the site's auto-approval switch. Spam filtering and the
  // comment.approve filter may downgrade it further; nothing may promote it.
  if (input.viaWebmention) status = "pending";
  if (settings.commentModeration) status = "pending";
  if (moderationFlags(haystack, settings.commentModerationWords)) status = "pending";

  // Comment-moderation plugins (e.g. comment-guard) may downgrade approval.
  const reviewed = await applyAsyncFilters<{
    comment: { content: string; userId?: number | null; authorUrl?: string | null };
    status: "published" | "pending" | "spam";
    reason?: string;
  }>(HOOKS.commentApprove, {
    comment: { content, userId, authorUrl },
    status,
    reason: undefined,
  });
  status = reviewed.status;
  if (input.viaWebmention && status === "published") status = "pending";

  const [comment] = await db
    .insert(comments)
    .values({
      postId: input.postId,
      postType,
      parentId,
      userId,
      authorName,
      authorEmail,
      authorUrl,
      content,
      status,
      ip: input.ip ?? null,
    })
    .returning();

  if (status === "published") await bumpCommentCount(postType, input.postId, 1);
  // A published submission changes what the post page renders (comment list +
  // count) — drop the content caches so it shows up on the next render, not a
  // TTL later. Pending/spam don't render, nothing to drop.
  if (status === "published") invalidateContentCaches();
  // Notification etc. plugins (comment.created); pending comments fire too.
  doAction(HOOKS.commentCreated, {
    comment,
    postType,
    postId: input.postId,
    postTitle: parent.title,
    isPublic: status === "published",
  });
  emitAdminEvent("comment");
  return { comment, isPublic: status === "published" };
}

export async function updateComment(
  user: SessionUser | null,
  id: number,
  patch: { status?: string; content?: string },
) {
  const u = requireUser(user);
  if (!can(u.role, "content:update:any")) throw new ServiceError("权限不足", 403);
  if (patch.status !== undefined && !["published", "pending", "spam"].includes(patch.status))
    throw new ServiceError("非法的评论状态", 422);
  if (patch.content !== undefined) {
    const c = String(patch.content).trim();
    if (!c) throw new ServiceError("评论内容不能为空", 422);
    if (c.length > 5000) throw new ServiceError("评论内容过长", 422);
  }
  const [existing] = await db.select().from(comments).where(eq(comments.id, id));
  if (!existing) throw new ServiceError("评论不存在", 404);
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.content !== undefined) set.content = patch.content;
  await db.update(comments).set(set).where(eq(comments.id, id));
  if (patch.status && patch.status !== existing.status) {
    if (patch.status === "published" && existing.status !== "published")
      await bumpCommentCount(existing.postType, existing.postId, 1);
    if (existing.status === "published" && patch.status !== "published")
      await bumpCommentCount(existing.postType, existing.postId, -1);
  }
  const [row] = await db.select().from(comments).where(eq(comments.id, id));
  invalidateContentCaches();
  emitAdminEvent("comment");
  // R270: keep the provenance pair honest in BOTH directions — if this comment
  // came from a webmention, the inbox's status follows the verdict the
  // moderator just recorded here (comment→mention). published=accepted,
  // anything else (pending/spam)=rejected; a mention row is never "pending"
  // once it has a comment, so pending maps to nothing.
  const stateToMention: Record<string, string | null> = { published: "accepted", spam: "rejected", pending: null };
  const mentionStatus = stateToMention[row.status] ?? null;
  if (mentionStatus) {
    await db.update(webmentions).set({ status: mentionStatus }).where(eq(webmentions.commentId, id));
  }
  return row;
}

export async function deleteComment(user: SessionUser | null, id: number) {
  const u = requireUser(user);
  if (!can(u.role, "content:delete:any")) throw new ServiceError("权限不足", 403);
  const [existing] = await db.select().from(comments).where(eq(comments.id, id));
  if (!existing) throw new ServiceError("评论不存在", 404);
  if (existing.status === "published")
    await bumpCommentCount(existing.postType, existing.postId, -1);
  await db.delete(comments).where(eq(comments.id, id));
  // R270: a deleted provenance comment leaves the mention row pointing at a
  // ghost commentId. Reset it so the inbox row survives as its own record.
  await db.update(webmentions).set({ commentId: null }).where(eq(webmentions.commentId, id));
  invalidateContentCaches();
  emitAdminEvent("comment");
  return { id };
}

export async function setCommentsStatus(
  user: SessionUser | null,
  ids: number[],
  // The API route validates the three states at the trust boundary
  // (api/comments/bulk.rose); this is the honest contract below it.
  status: (typeof commentStateEnum.enumValues)[number],
) {
  const u = requireUser(user);
  if (!can(u.role, "content:update:any")) throw new ServiceError("权限不足", 403);
  if (!ids.length) return [];
  // Batched, not a per-id loop: a spam-flush of hundreds of comments used to
  // issue SELECT+UPDATE(+bump) for every id. One read of the affected rows, one
  // bulk UPDATE, then the comment-count deltas folded per (postType, postId) so
  // a whole thread's worth of changes is a single increment.
  const rows = await db
    .select({ id: comments.id, status: comments.status, postType: comments.postType, postId: comments.postId })
    .from(comments)
    .where(inArray(comments.id, ids));
  const present = rows.map((r) => r.id);
  if (!present.length) return [];
  await db.update(comments).set({ status }).where(inArray(comments.id, present));

  // Net commentsCount delta per content: +1 per row newly published, -1 per row
  // leaving published. Only rows whose status actually changed contribute.
  const delta = new Map<string, number>();
  for (const r of rows) {
    const d = (status === "published" ? 1 : 0) - (r.status === "published" ? 1 : 0);
    if (d === 0) continue;
    const k = `${r.postType}:${r.postId}`;
    delta.set(k, (delta.get(k) ?? 0) + d);
  }
  await Promise.all(
    [...delta.entries()].map(([k, d]) => {
      const [postType, idStr] = k.split(":");
      return bumpCommentCount(postType, Number(idStr), d);
    }),
  );
  await recordAdminAction(u, "comments.bulk_status", { ids: present, status });
  emitAdminEvent("comment");
  // R270: same provenance rule as updateComment — bulk verdicts on webmention
  // comments carry back to the inbox rows (published=accepted, spam=rejected).
  if (status === "published" || status === "spam") {
    await db
      .update(webmentions)
      .set({ status: status === "published" ? "accepted" : "rejected" })
      .where(inArray(webmentions.commentId, present));
  }
  return present;
}

export async function deleteComments(user: SessionUser | null, ids: number[]) {
  const u = requireUser(user);
  if (!can(u.role, "content:delete:any")) throw new ServiceError("权限不足", 403);
  if (!ids.length) return [];
  // Batched, not a per-id loop (same shape as setCommentsStatus above): read the
  // affected rows once, delete them in one statement, then fold the comment-count
  // decrements per (postType, postId) - only published comments were counted.
  const rows = await db
    .select({ id: comments.id, status: comments.status, postType: comments.postType, postId: comments.postId })
    .from(comments)
    .where(inArray(comments.id, ids));
  const present = rows.map((r) => r.id);
  if (!present.length) return [];
  await db.delete(comments).where(inArray(comments.id, present));
  const delta = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== "published") continue;
    const k = `${r.postType}:${r.postId}`;
    delta.set(k, (delta.get(k) ?? 0) - 1);
  }
  await Promise.all(
    [...delta.entries()].map(([k, d]) => {
      const [postType, idStr] = k.split(":");
      return bumpCommentCount(postType, Number(idStr), d);
    }),
  );
  await recordAdminAction(u, "comments.delete", { ids: present });
  // R270: bulk delete detaches provenance mentions too (same rule as
  // deleteComment) — the inbox row survives with its commentId reset.
  await db.update(webmentions).set({ commentId: null }).where(inArray(webmentions.commentId, present));
  return present;
}

// --------------------------------------------------------------- taxonomies

function cleanOpt(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v === "" || v === null ? null : v;
}

async function takenCategorySlugs(base: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(sql`${categories.slug} LIKE ${base + "%"}`);
  return new Set(rows.map((r) => r.slug));
}

async function takenTagSlugs(base: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: tags.slug })
    .from(tags)
    .where(sql`${tags.slug} LIKE ${base + "%"}`);
  return new Set(rows.map((r) => r.slug));
}

export async function createCategory(
  user: SessionUser,
  input: { name: string; slug?: string; description?: string; icon?: string; parentId?: number | null },
) {
  requireCap(user, "taxonomy:manage");
  const name = (input.name || "").trim();
  if (!name) throw new ServiceError("分类名称不能为空", 422);
  const base = slugify(input.slug || name);
  const slug = uniqueSlug(base, await takenCategorySlugs(base));
  const [row] = await db
    .insert(categories)
    .values({
      name,
      slug,
      description: cleanOpt(input.description) ?? null,
      icon: cleanOpt(input.icon) ?? null,
      parentId: input.parentId ?? null,
    })
    .returning();
  invalidateContentCaches();
  return row;
}

export async function updateCategory(
  user: SessionUser,
  id: number,
  input: Partial<{ name: string; slug: string; description: string; icon: string; parentId: number | null }>,
) {
  requireCap(user, "taxonomy:manage");
  const [existing] = await db.select().from(categories).where(eq(categories.id, id));
  if (!existing) throw new ServiceError("分类不存在", 404);
  let slug = existing.slug;
  if (input.slug && input.slug !== existing.slug) {
    const base = slugify(input.slug);
    const taken = await takenCategorySlugs(base);
    taken.delete(existing.slug);
    slug = uniqueSlug(base, taken);
  }
  await db
    .update(categories)
    .set({
      name: input.name ?? existing.name,
      slug,
      description:
        input.description !== undefined ? cleanOpt(input.description) : existing.description,
      icon: input.icon !== undefined ? cleanOpt(input.icon) : existing.icon,
      parentId: input.parentId !== undefined ? input.parentId : existing.parentId,
    })
    .where(eq(categories.id, id));
  // R193: an archive URL is its term slug too, so a renamed category orphans
  // every link to its archive in the same way a renamed post does.
  if (slug !== existing.slug) {
    const cfg = await getPermalinkConfig();
    await captureRename(categoryUrlFor(cfg, existing), categoryUrlFor(cfg, { ...existing, slug }));
  }
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  invalidateContentCaches();
  return row;
}

export async function deleteCategory(user: SessionUser, id: number) {
  requireCap(user, "taxonomy:manage");
  await db.update(categories).set({ parentId: null }).where(eq(categories.parentId, id));
  await db.delete(categories).where(eq(categories.id, id));
  invalidateContentCaches();
  return { id };
}

/**
 * Bulk-delete categories. Posts attached to any deleted category are detached
 * from it (their post_categories rows are removed, so they fall back to
 * "uncategorized") rather than being deleted. Surviving children of a deleted
 * category are promoted to top-level. Explicit junction cleanup keeps the
 * cascade correct even if the FK onDelete rule was not applied by migrations.
 */
export async function bulkDeleteCategories(user: SessionUser, ids: number[]) {
  requireCap(user, "taxonomy:manage");
  const set = Array.from(new Set((ids || []).filter((n) => Number.isInteger(n) && n > 0)));
  if (!set.length) return { deleted: 0 };
  await db.delete(postCategories).where(inArray(postCategories.categoryId, set));
  await db.update(categories).set({ parentId: null }).where(inArray(categories.parentId, set));
  await db.delete(categories).where(inArray(categories.id, set));
  invalidateContentCaches();
  await recordAdminAction(user, "taxonomy.bulk_delete", { kind: "category", ids: set });
  return { deleted: set.length };
}

export async function reorderCategories(
  user: SessionUser,
  items: Array<{ id: number; parentId: number | null; order: number }>,
) {
  requireCap(user, "taxonomy:manage");
  const clean = items.filter((it) => Number.isInteger(it.id) && it.id > 0);
  if (!clean.length) return { ok: true };
  // One CASE UPDATE instead of a per-item loop, mirroring reorderMedia: a drag
  // of the whole taxonomy used to issue one UPDATE per row.
  const cases = sql.join(
    clean.map((it) =>
      sql`when ${categories.id} = ${it.id} then ${it.parentId === null ? sql`null` : it.parentId}`,
    ),
    sql` `,
  );
  const orderCases = sql.join(
    clean.map((it) => sql`when ${categories.id} = ${it.id} then ${Number(it.order) || 0}`),
    sql` `,
  );
  await db.execute(
    sql`update ${categories} set parent_id = case ${cases} else parent_id end, "order" = case ${orderCases} else "order" end`,
  );
  return { ok: true };
}

export async function createTag(user: SessionUser, input: { name: string; slug?: string }) {
  requireCap(user, "taxonomy:manage");
  const name = (input.name || "").trim();
  if (!name) throw new ServiceError("标签名称不能为空", 422);
  const base = slugify(input.slug || name);
  const slug = uniqueSlug(base, await takenTagSlugs(base));
  const [row] = await db.insert(tags).values({ name, slug }).returning();
  invalidateContentCaches();
  return row;
}

export async function updateTag(user: SessionUser, id: number, input: Partial<{ name: string; slug: string }>) {
  requireCap(user, "taxonomy:manage");
  const [existing] = await db.select().from(tags).where(eq(tags.id, id));
  if (!existing) throw new ServiceError("标签不存在", 404);
  let slug = existing.slug;
  if (input.slug && input.slug !== existing.slug) {
    const base = slugify(input.slug);
    const taken = await takenTagSlugs(base);
    taken.delete(existing.slug);
    slug = uniqueSlug(base, taken);
  }
  await db
    .update(tags)
    .set({ name: input.name ?? existing.name, slug })
    .where(eq(tags.id, id));
  if (slug !== existing.slug) {
    const cfg = await getPermalinkConfig();
    await captureRename(tagUrlFor(cfg, existing), tagUrlFor(cfg, { ...existing, slug }));
  }
  const [row] = await db.select().from(tags).where(eq(tags.id, id));
  invalidateContentCaches();
  return row;
}

export async function deleteTag(user: SessionUser, id: number) {
  requireCap(user, "taxonomy:manage");
  await db.delete(tags).where(eq(tags.id, id));
  invalidateContentCaches();
  return { id };
}

/**
 * Bulk-delete tags. The post_tags junction rows for the deleted tags are
 * removed explicitly so every affected post simply loses that tag (it is not
 * deleted). Mirrors bulkDeleteCategories' defensive stance on the cascade.
 */
export async function bulkDeleteTags(user: SessionUser, ids: number[]) {
  requireCap(user, "taxonomy:manage");
  const set = Array.from(new Set((ids || []).filter((n) => Number.isInteger(n) && n > 0)));
  if (!set.length) return { deleted: 0 };
  await db.delete(postTags).where(inArray(postTags.tagId, set));
  await db.delete(tags).where(inArray(tags.id, set));
  invalidateContentCaches();
  await recordAdminAction(user, "taxonomy.bulk_delete", { kind: "tag", ids: set });
  return { deleted: set.length };
}

// ------------------------------------------------------------------ settings

/** Whitelisted site_settings columns the admin form may patch. */
const SETTINGS_FIELDS = {
  str: [
    "siteTitle", "siteDescription", "tagline", "logoUrl", "faviconUrl", "footerText",
    "icpNumber", "avatarSource", "avatarDefault", "avatarRating", "homeDisplay",
    "feedContent", "seoTitleTemplate", "seoKeywords", "seoDefaultDescription",
    "seoRobots", "ogImageUrl", "twitterCard", "twitterSite", "customHead",
    "customFooter", "customCss", "analyticsId", "timezone", "dateFormat", "language",
    "commentProvider", "commentDefaultContent", "commentModerationWords",
    "artalkServer", "artalkSite", "giscusRepo", "giscusRepoId", "giscusCategory",
    "giscusCategoryId", "giscusMapping", "giscusTheme", "walineServer", "twikooEnvId",
    "disqusShortname", "utterancesRepo", "utterancesTerm", "webhook_url",
    "activeThemeSlug",
  ],
  num: ["avatarSize", "postsPerPage", "feedItems", "excerptLength"],
  /** Nullable integer columns: empty/absent → null, otherwise coerced. */
  numNullable: ["homePageId", "postsPageId"],
  bool: ["commentsEnabled", "requireNameEmail", "requireAuthorUrl", "commentModeration", "giscusReactions"],
  json: ["socialLinks", "footerLinks", "verifications"],
} as const;

export async function updateSettings(user: SessionUser, input: Record<string, unknown>) {
  requireCap(user, "settings:manage");
  if (typeof input.activeThemeSlug === "string") {
    // Lazy import: themes.js depends on this module (ServiceError).
    const { isPublicThemePorted, getThemeManifest } = await import("./themes.js");
    const slug = input.activeThemeSlug.trim();
    if (!getThemeManifest(slug)) throw new ServiceError("主题不存在", 422);
    if (!isPublicThemePorted(slug)) {
      throw new ServiceError("该主题的前台模板尚未适配，暂不能启用", 422);
    }
  }
  await db.insert(siteSettings).values({ id: 1 }).onConflictDoNothing();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of SETTINGS_FIELDS.str) if (k in input && typeof input[k] === "string") set[k] = input[k];
  for (const k of SETTINGS_FIELDS.num)
    if (k in input && Number.isFinite(Number(input[k]))) set[k] = Number(input[k]);
  for (const k of SETTINGS_FIELDS.numNullable) {
    if (!(k in input)) continue;
    const raw = input[k];
    set[k] = raw === "" || raw == null ? null : Number(raw);
  }
  for (const k of SETTINGS_FIELDS.bool) if (k in input) set[k] = Boolean(input[k]);
  for (const k of SETTINGS_FIELDS.json)
    if (k in input && (typeof input[k] === "object" || Array.isArray(input[k]))) set[k] = input[k];
  const [row] = await db
    .update(siteSettings)
    .set(set)
    .where(eq(siteSettings.id, 1))
    .returning();
  invalidateSettings();
  // R151: site settings are SITE-WIDE derived data - the title rides every
  // head, feed channel and sitemap entry; postsPerPage/feedItems/feedContent
  // move the pagination WINDOWS and feed bodies themselves (the R146 window
  // math and the R150 `doc:` memos read them). invalidateSettings() alone
  // dropped only the settings row memo, so a save stayed invisible in the
  // response hot cache (10s), the `doc:` documents (30s) and the kv bundles
  // (60s) - three different stale windows for one edit. A settings save is a
  // rare, deploy-grade admin event: invalidate everything at the commit point
  // (the theme-switch branch below already did exactly this, and bootstrap
  // below now does too).
  invalidateContentCaches();
  if (typeof input.activeThemeSlug === "string") {
    // Clear the render memo so the next request re-renders with the new theme.
    // invalidateContentCaches() is the app's cache-invalidation entry point
    // (server/cache.ts) — the previously referenced invalidateRenderCache() was
    // never defined or imported anywhere in this project, so saving any
    // settings payload containing activeThemeSlug threw
    // `ReferenceError: invalidateRenderCache is not defined` and 500'd the
    // whole /api/settings route (i.e. every theme switch from the admin).
    invalidateContentCaches();
    // Lazy import: themes.js depends on this module (ServiceError).
    const { invalidateActiveThemeCache } = await import("./themes.js");
    invalidateActiveThemeCache();
  }
  return row;
}

/**
 * Unauthenticated settings bootstrap used solely by first-run /api/setup
 * (mirrors the updateSettings() call in app/api/setup/route.ts). Only the
 * four installer fields are accepted; /api/setup enforces no-users state.
 */
export async function bootstrapSiteSettings(input: Record<string, unknown>): Promise<void> {
  const limits: Record<string, number> = {
    siteTitle: 120,
    siteDescription: 300,
    tagline: 120,
    footerText: 200,
  };
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, max] of Object.entries(limits)) {
    if (typeof input[k] === "string") set[k] = (input[k] as string).slice(0, max);
  }
  if (Object.keys(set).length === 1) return;
  await db.insert(siteSettings).values({ id: 1 }).onConflictDoNothing();
  await db.update(siteSettings).set(set).where(eq(siteSettings.id, 1));
  invalidateSettings();
  // R151: first-run pages render BEFORE setup completes, so the hot cache may
  // already hold chrome built from EMPTY settings - the installer's title must
  // be visible on the very next request, not after the hot TTL.
  invalidateContentCaches();
}

// --------------------------------------------------------------------- users

function publicUser(u: any) {
  const { passwordHash, ...rest } = u;
  return rest;
}

export async function adminListUsers(user: SessionUser) {
  requireCap(user, "users:read");
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  return rows.map(publicUser);
}

export async function createUser(
  user: SessionUser,
  input: { email: string; name: string; password: string; role?: Role; bio?: string },
) {
  requireCap(user, "users:manage");
  const email = (input.email || "").trim();
  const name = (input.name || "").trim();
  if (!email || !name || !input.password)
    throw new ServiceError("邮箱、昵称和密码不能为空", 422);
  parseOrThrow(
    v.object({
      email: v.email({ label: "邮箱" }),
      name: v.string({ min: 1, max: 64, label: "昵称" }),
    }),
    { email, name },
  );
  const pwErr = passwordError(input.password, { email, name });
  if (pwErr) throw pwErr;
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (exists) throw new ServiceError("邮箱已存在", 422);
  const [row] = await db
    .insert(users)
    .values({
      email,
      name,
      passwordHash: await hashPassword(input.password),
      role: input.role ?? "author",
      bio: input.bio ?? null,
    })
    .returning();
  return publicUser(row);
}

export async function updateUser(
  actorIn: SessionUser | null,
  id: number,
  input: Partial<{ name: string; email: string; password: string; role: Role; status: string; bio: string }>,
) {
  const actor = requireUser(actorIn);
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new ServiceError("用户不存在", 404);
  const isSelf = actor.id === id;
  const managing = can(actor.role, "users:manage");
  if ((input.role !== undefined || input.email !== undefined || input.status !== undefined) && !managing)
    throw new ServiceError("无权修改角色、邮箱或账号状态", 403);
  if (!isSelf && !managing) throw new ServiceError("无权修改其他用户", 403);
  if (input.role !== undefined && !["admin", "editor", "author", "subscriber"].includes(input.role))
    throw new ServiceError("非法的用户角色", 422);
  if (input.email !== undefined && input.email !== null && String(input.email).trim() !== "") {
    const nextEmail = String(input.email).trim();
    parseOrThrow(v.object({ email: v.email({ label: "邮箱" }) }), { email: nextEmail });
  }
  if (input.name !== undefined && input.name !== null && String(input.name).trim().length > 64)
    throw new ServiceError("昵称长度不能超过 64 个字符", 422);
  if (input.status !== undefined) {
    const nextStatus = String(input.status ?? "").trim();
    if (!nextStatus || nextStatus.length > 32)
      throw new ServiceError("非法的账号状态", 422);
  }
  if (input.password) {
    const pwErr = passwordError(input.password, {
      email: input.email ?? target.email,
      name: input.name ?? target.name,
    });
    if (pwErr) throw pwErr;
  }
  const [row] = await db
    .update(users)
    .set({
      name: input.name ?? target.name,
      bio: input.bio !== undefined ? input.bio : target.bio,
      email: input.email ?? target.email,
      role: input.role ?? target.role,
      status: (input.status ?? target.status) as any,
      passwordHash: input.password ? await hashPassword(input.password) : target.passwordHash,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning();
  // The hydrated post/page views carry the author's name and email, so a
  // rename or an email change has to drop them or the old name keeps serving
  // for the whole SWR window.
  invalidateContentCaches();
  return publicUser(row);
}

export async function deleteUser(actor: SessionUser | null, id: number) {
  const u = requireUser(actor);
  if (!can(u.role, "users:manage")) throw new ServiceError("权限不足", 403);
  if (u.id === id) throw new ServiceError("不能删除当前登录账号", 422);
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  if (!target) throw new ServiceError("用户不存在", 404);
  await db.delete(users).where(eq(users.id, id));
  // Posts keep their author row cached by id; dropping the user must not keep
  // a deleted author's name on the public site for the rest of the window.
  invalidateContentCaches();
  return { id };
}

// ----------------------------------------------------------------- dashboard

export async function dashboardStats(user: SessionUser) {
  requireCap(user, "content:read");
  // R163: every read below is independent of every other one, yet this used to
  // be a chain of eleven serial round trips (status -> comments -> recent posts
  // -> recent comments -> titles -> six counts). On a remote Postgres each leg
  // is a full RTT, so the dashboard paid ~10 extra legs before first paint.
  // One opening wave now; only the title lookup depends on recentComments.
  const countQ = (t: any) => db.select({ n: sql<number>`count(*)` }).from(t);
  const [
    [postStatusRows],
    [commentRows],
    recentPosts,
    recentComments,
    [postCount],
    [pageCount],
    [mediaCount],
    [userCount],
    [catCount],
    [tagCount],
  ] = await Promise.all([
    db
      .select({
        draft: sql<number>`sum(case when status='draft' then 1 else 0 end)`,
        published: sql<number>`sum(case when status='published' then 1 else 0 end)`,
        archived: sql<number>`sum(case when status='archived' then 1 else 0 end)`,
      })
      .from(posts),
    db
      .select({
        total: sql<number>`count(*)`,
        pending: sql<number>`sum(case when status='pending' then 1 else 0 end)`,
      })
      .from(comments),
    db
      .select({ id: posts.id, title: posts.title, status: posts.status, updatedAt: posts.updatedAt })
      .from(posts)
      .orderBy(desc(posts.updatedAt))
      .limit(6),
    db
      .select({
        id: comments.id,
        authorName: comments.authorName,
        content: comments.content,
        status: comments.status,
        postId: comments.postId,
        postType: comments.postType,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .orderBy(desc(comments.createdAt))
      .limit(6),
    countQ(posts),
    countQ(pages),
    countQ(media),
    countQ(users),
    countQ(categories),
    countQ(tags),
  ]);
  // Resolve each recent comment's post/page title. Keyed by "type:id" (posts
  // and pages share the id space, so postId alone would collide) and batched
  // into one query per type instead of one query per comment (N+1).
  const titles = new Map<string, string>();
  const postIds = [...new Set(recentComments.filter((c) => c.postType !== "page").map((c) => c.postId))];
  const pageIds = [...new Set(recentComments.filter((c) => c.postType === "page").map((c) => c.postId))];
  const [postTitleRows, pageTitleRows] = await Promise.all([
    postIds.length
      ? db.select({ id: posts.id, title: posts.title }).from(posts).where(inArray(posts.id, postIds))
      : Promise.resolve([] as { id: number; title: string }[]),
    pageIds.length
      ? db.select({ id: pages.id, title: pages.title }).from(pages).where(inArray(pages.id, pageIds))
      : Promise.resolve([] as { id: number; title: string }[]),
  ]);
  for (const r of postTitleRows) titles.set(`post:${r.id}`, r.title);
  for (const r of pageTitleRows) titles.set(`page:${r.id}`, r.title);
  return {
    counts: {
      posts: Number(postCount?.n ?? 0),
      pages: Number(pageCount?.n ?? 0),
      media: Number(mediaCount?.n ?? 0),
      users: Number(userCount?.n ?? 0),
      categories: Number(catCount?.n ?? 0),
      tags: Number(tagCount?.n ?? 0),
      comments: Number(commentRows?.total ?? 0),
      commentsPending: Number(commentRows?.pending ?? 0),
    },
    postStatus: {
      draft: Number(postStatusRows?.draft ?? 0),
      published: Number(postStatusRows?.published ?? 0),
      archived: Number(postStatusRows?.archived ?? 0),
    },
    recentPosts: recentPosts.map((p) => ({
      ...p,
      updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : "",
    })),
    recentComments: recentComments.map((rc) => ({
      ...rc,
      content: rc.content.slice(0, 80),
      postTitle: titles.get(`${rc.postType}:${rc.postId}`) ?? "（已删除）",
      createdAt: rc.createdAt ? new Date(rc.createdAt).toISOString() : "",
    })),
  };
}
