/**
 * Admin service layer + Web API helpers — ported from the original
 * (lib/services/{posts,comments,taxonomies,settings,users,dashboard}.ts and
 * lib/http.ts), trimmed to what the B-phase admin uses:
 *
 *  - no plugin hooks, no cross-response caches (every request reads the DB —
 *    the core invariant of this port),
 *  - no pinyin dictionary: pinyin link tails reuse the slug (the public
 *    resolver falls back to slug anyway),
 *  - no avatars/metas/reply UI (later phases).
 *
 * Everything here is server-only: imported exclusively by pages/api/*.rose
 * and the admin.* loader keys, which never enter the client bundle.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
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
  type Block,
  type Role,
} from "./schema.js";
import {
  getSettings,
  invalidateSettings,
  listCategories as allCategories,
  listComments,
  listTags as allTags,
} from "./queries.js";
import type { SessionUser } from "./auth.js";
import { hashPassword } from "./auth.js";

export class ServiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

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

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function jsonFail(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function readBody(req: Request): Promise<any> {
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

/** Wrap an API handler: lazy migrations, ServiceError/status mapping. */
export async function apiGate(
  fn: () => Promise<Response | unknown>,
): Promise<Response> {
  try {
    await ensureMigrations();
    const out = await fn();
    if (out instanceof Response) return out;
    return jsonOk(out ?? null);
  } catch (e) {
    if (e instanceof ServiceError) return jsonFail(e.message, e.status);
    console.error("[admin api]", e);
    const detail =
      process.env.DEBUG_API_ERRORS === "true" && e instanceof Error ? `: ${e.message}` : "";
    return jsonFail("服务器内部错误" + detail, 500);
  }
}

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
};

/** Admin post list — all statuses, joined author + taxonomy names. */
export async function adminListPosts(user: SessionUser, f: PostListFilter = {}) {
  requireCap(user, "content:read");
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;
  const conditions = [];
  if (f.status) conditions.push(eq(posts.status, f.status as any));
  if (!can(user.role, "content:update:any"))
    conditions.push(eq(posts.authorId, user.id));
  if (f.search)
    conditions.push(
      sql`(${posts.title} ILIKE ${"%" + f.search + "%"} OR ${posts.excerpt} ILIKE ${"%" + f.search + "%"})`,
    );
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({
      post: posts,
      authorName: users.name,
    })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .where(where)
    .orderBy(desc(posts.updatedAt))
    .limit(limit)
    .offset(offset);

  const [totalRows] = await db
    .select({ n: sql<number>`count(*)` })
    .from(posts)
    .where(where);

  const ids = rows.map((r) => r.post.id);
  const tax = await attachTaxonomyIds(ids);
  const [catRows, tagRows] = await Promise.all([allCategories(), allTags()]);
  const catName = new Map(catRows.map((c) => [c.id, c]));
  const tagName = new Map(tagRows.map((t) => [t.id, t]));

  const items = rows.map((r) => ({
    ...r.post,
    authorName: r.authorName,
    categories: (tax.cats[r.post.id] ?? []).map((id) => catName.get(id)).filter(Boolean),
    tags: (tax.tags[r.post.id] ?? []).map((id) => tagName.get(id)).filter(Boolean),
  }));
  return { items, total: Number(totalRows?.n ?? 0) };
}

export async function adminGetPost(user: SessionUser, id: number) {
  requireCap(user, "content:read");
  const [row] = await db.select().from(posts).where(eq(posts.id, id));
  if (!row) throw new ServiceError("文章不存在", 404);
  if (!canModifyContent(user.role, row.authorId, user.id))
    throw new ServiceError("权限不足", 403);
  const tax = await attachTaxonomyIds([id]);
  return { ...row, categoryIds: tax.cats[id] ?? [], tagIds: tax.tags[id] ?? [] };
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
  format?: string;
  template?: string | null;
  publishedAt?: string | null;
  authorId?: number;
  categoryIds?: number[];
  tagIds?: number[];
};

function clean(v: string | null | undefined): string | null {
  return v === undefined || v === null || v === "" ? null : v;
}

function normIds(v: unknown): number[] {
  return Array.isArray(v)
    ? v.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
}

export async function createPost(user: SessionUser, input: PostInput) {
  requireCap(user, "content:create");
  const title = (input.title || "").trim();
  if (!title) throw new ServiceError("标题不能为空", 422);
  const content = Array.isArray(input.content) ? input.content : [];
  const slugBase = slugify(input.slug || title);
  const slug = uniqueSlug(slugBase, await takenSlugs(slugBase));
  const authorId =
    (user.role === "admin" || user.role === "editor") && input.authorId
      ? Number(input.authorId)
      : user.id;
  const status = input.status ?? "draft";
  const excerpt =
    input.excerpt || excerptFrom(blocksToPlainText(content));

  const [row] = await db
    .insert(posts)
    .values({
      title,
      slug,
      pinyinSlug: slug,
      initialSlug: slug,
      excerpt,
      content,
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
      pinned: input.pinned ?? false,
      template: clean(input.template),
    })
    .returning();
  await setTaxonomies(row.id, normIds(input.categoryIds), normIds(input.tagIds));
  return adminGetPost(user, row.id);
}

export async function updatePost(user: SessionUser, id: number, input: Partial<PostInput>) {
  const existing = await adminGetPost(user, id);
  let slug = existing.slug;
  if (input.slug && input.slug !== existing.slug) {
    const base = slugify(input.slug);
    const taken = await takenSlugs(base);
    taken.delete(existing.slug);
    slug = uniqueSlug(base, taken);
  }
  const content = input.content ?? (existing.content as Block[]);
  let publishedAt = existing.publishedAt;
  if (input.publishedAt) publishedAt = new Date(input.publishedAt);
  else if (input.status === "published" && !existing.publishedAt) publishedAt = new Date();
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
      excerpt:
        input.excerpt !== undefined
          ? input.excerpt || excerptFrom(blocksToPlainText(content))
          : existing.excerpt,
      content,
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
      pinned: input.pinned !== undefined ? input.pinned : existing.pinned,
      template: input.template !== undefined ? clean(input.template) : existing.template,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, id));

  if (input.categoryIds || input.tagIds)
    await setTaxonomies(id, normIds(input.categoryIds), normIds(input.tagIds));
  return adminGetPost(user, id);
}

export async function deletePost(user: SessionUser, id: number) {
  const existing = await adminGetPost(user, id);
  if (!canModifyContent(user.role, existing.authorId, user.id))
    throw new ServiceError("权限不足", 403);
  await db.delete(posts).where(eq(posts.id, id));
  return { id };
}

export async function bulkPosts(
  user: SessionUser | null,
  ids: number[],
  action: "publish" | "draft" | "archive" | "delete",
) {
  requireUser(user);
  const rows = await db
    .select({ id: posts.id, authorId: posts.authorId })
    .from(posts)
    .where(inArray(posts.id, ids));
  const allowed = rows.filter((p) => canModifyContent(user.role, p.authorId, user.id));
  if (!allowed.length) return { affected: 0 };
  const allowedIds = allowed.map((p) => p.id);
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
  return { affected: allowedIds.length };
}

async function bumpCommentCount(postType: string, postId: number, delta: number) {
  const t = postType === "page" ? pages : posts;
  await db
    .update(t)
    .set({ commentsCount: sql`${t.commentsCount} + ${delta}` })
    .where(eq(t.id, postId));
}

export async function adminListComments(
  user: SessionUser,
  f: { status?: string; limit?: number; offset?: number } = {},
) {
  requireCap(user, "content:read");
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;
  const conditions = [];
  if (f.status) conditions.push(eq(comments.status, f.status as any));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(comments)
    .where(where)
    .orderBy(desc(comments.id))
    .limit(limit)
    .offset(offset);
  const [totalRows] = await db
    .select({ n: sql<number>`count(*)` })
    .from(comments)
    .where(where);

  const postIds = [...new Set(rows.map((r) => r.postId))];
  const titles = new Map<number, string>();
  const pRows = await db
    .select({ id: posts.id, title: posts.title })
    .from(posts)
    .where(inArray(posts.id, postIds));
  for (const r of pRows) titles.set(r.id, r.title);
  const missing = postIds.filter((id) => !titles.has(id));
  if (missing.length) {
    const gRows = await db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(inArray(pages.id, missing));
    for (const r of gRows) titles.set(r.id, r.title);
  }
  const items = rows.map((c) => ({ ...c, postTitle: titles.get(c.postId) ?? "（已删除）" }));
  return { items, total: Number(totalRows?.n ?? 0) };
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
};

export async function createPublicComment(input: PublicCommentInput) {
  const postType = input.postType ?? "post";
  const t = postType === "page" ? pages : posts;
  const [parent] = await db
    .select({ commentStatus: t.commentStatus, title: t.title })
    .from(t)
    .where(eq(t.id, input.postId));
  if (!parent) throw new ServiceError("内容不存在", 404);

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
    throw new ServiceError("评论已关闭", 403);
  if (parent.commentStatus === "closed" && !isStaff)
    throw new ServiceError("本文评论已关闭", 403);

  const content = (input.content || "").trim();
  if (!content) throw new ServiceError("评论内容不能为空", 422);
  if (content.length > 5000) throw new ServiceError("评论内容过长", 422);

  let authorName = input.authorName?.trim() || "匿名";
  let authorEmail = input.authorEmail ?? null;
  let authorUrl = input.authorUrl ?? null;
  let userId: number | null = null;

  if (input.user) {
    const [u] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, input.user.id));
    if (u) {
      authorName = u.name;
      authorEmail = u.email;
      userId = input.user.id;
    }
  } else {
    if (settings.requireNameEmail && (!input.authorName?.trim() || !input.authorEmail?.trim()))
      throw new ServiceError("请填写昵称和邮箱", 422);
  }

  await assertNotImpersonation({ authorName, authorEmail, authorUrl, siteHost: input.siteHost });

  const haystack = [content, authorName, authorEmail ?? "", authorUrl ?? ""].join("\n");
  let status: "published" | "pending" | "spam" = "published";
  if (settings.commentModeration) status = "pending";
  const words = String(settings.commentModerationWords || "")
    .split(/\r?\n/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.some((w) => haystack.includes(w))) status = "pending";

  const [comment] = await db
    .insert(comments)
    .values({
      postId: input.postId,
      postType,
      parentId: input.parentId ?? null,
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
  return { comment, isPublic: status === "published" };
}

export async function updateComment(
  user: SessionUser | null,
  id: number,
  patch: { status?: string; content?: string },
) {
  const u = requireUser(user);
  if (!can(u.role, "content:update:any")) throw new ServiceError("权限不足", 403);
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
  return { id };
}

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
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  return row;
}

export async function deleteCategory(user: SessionUser, id: number) {
  requireCap(user, "taxonomy:manage");
  await db.update(categories).set({ parentId: null }).where(eq(categories.parentId, id));
  await db.delete(categories).where(eq(categories.id, id));
  return { id };
}

export async function createTag(user: SessionUser, input: { name: string; slug?: string }) {
  requireCap(user, "taxonomy:manage");
  const name = (input.name || "").trim();
  if (!name) throw new ServiceError("标签名称不能为空", 422);
  const base = slugify(input.slug || name);
  const slug = uniqueSlug(base, await takenTagSlugs(base));
  const [row] = await db.insert(tags).values({ name, slug }).returning();
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
  const [row] = await db.select().from(tags).where(eq(tags.id, id));
  return row;
}

export async function deleteTag(user: SessionUser, id: number) {
  requireCap(user, "taxonomy:manage");
  await db.delete(tags).where(eq(tags.id, id));
  return { id };
}

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
    "disqusShortname", "utterancesRepo", "utterancesTerm",
  ],
  num: ["avatarSize", "postsPerPage", "feedItems", "excerptLength"],
  bool: ["commentsEnabled", "requireNameEmail", "commentModeration", "giscusReactions"],
  json: ["socialLinks", "footerLinks", "verifications"],
} as const;

export async function updateSettings(user: SessionUser, input: Record<string, unknown>) {
  requireCap(user, "settings:manage");
  await db.insert(siteSettings).values({ id: 1 }).onConflictDoNothing();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of SETTINGS_FIELDS.str) if (k in input && typeof input[k] === "string") set[k] = input[k];
  for (const k of SETTINGS_FIELDS.num)
    if (k in input && Number.isFinite(Number(input[k]))) set[k] = Number(input[k]);
  for (const k of SETTINGS_FIELDS.bool) if (k in input) set[k] = Boolean(input[k]);
  for (const k of SETTINGS_FIELDS.json)
    if (k in input && (typeof input[k] === "object" || Array.isArray(input[k]))) set[k] = input[k];
  const [row] = await db
    .update(siteSettings)
    .set(set)
    .where(eq(siteSettings.id, 1))
    .returning();
  invalidateSettings();
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
}

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
  return publicUser(row);
}

export async function deleteUser(actor: SessionUser | null, id: number) {
  const u = requireUser(actor);
  if (!can(u.role, "users:manage")) throw new ServiceError("权限不足", 403);
  if (u.id === id) throw new ServiceError("不能删除当前登录账号", 422);
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  if (!target) throw new ServiceError("用户不存在", 404);
  await db.delete(users).where(eq(users.id, id));
  return { id };
}

export async function dashboardStats(user: SessionUser) {
  requireCap(user, "content:read");
  const count = async (t: any) =>
    Number((await db.select({ n: sql<number>`count(*)` }).from(t))[0]?.n ?? 0);

  const [postStatusRows] = await db
    .select({
      draft: sql<number>`sum(case when status='draft' then 1 else 0 end)`,
      published: sql<number>`sum(case when status='published' then 1 else 0 end)`,
      archived: sql<number>`sum(case when status='archived' then 1 else 0 end)`,
    })
    .from(posts);
  const [commentRows] = await db
    .select({
      total: sql<number>`count(*)`,
      pending: sql<number>`sum(case when status='pending' then 1 else 0 end)`,
    })
    .from(comments);
  const recentPosts = await db
    .select({ id: posts.id, title: posts.title, status: posts.status, updatedAt: posts.updatedAt })
    .from(posts)
    .orderBy(desc(posts.updatedAt))
    .limit(6);
  const recentComments = await db
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
    .limit(6);
  const titles = new Map<number, string>();
  for (const rc of recentComments) {
    const t = rc.postType === "page" ? pages : posts;
    const [p] = await db.select({ title: t.title }).from(t).where(eq(t.id, rc.postId));
    titles.set(rc.postId, p?.title ?? "（已删除）");
  }
  return {
    counts: {
      posts: await count(posts),
      pages: await count(pages),
      media: await count(media),
      users: await count(users),
      categories: await count(categories),
      tags: await count(tags),
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
      postTitle: titles.get(rc.postId) ?? "",
      createdAt: rc.createdAt ? new Date(rc.createdAt).toISOString() : "",
    })),
  };
}
