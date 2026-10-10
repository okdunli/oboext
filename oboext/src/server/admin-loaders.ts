/**
 * Isomorphic read loaders for the admin pages. They ride the same /api/data
 * channel as the public loaders (server render calls them directly, the
 * browser GETs /api/data), so every admin screen reads the LIVE database per
 * request. The middleware guarantees ctx.user for /admin pages; each loader
 * still re-checks because /api/data is reachable directly.
 */
import {
  dashboardStats,
  adminListPosts,
  adminGetPost,
  adminListComments,
  adminListUsers,
  ServiceError,
} from "./admin.js";
import { adminListPages, adminGetPage } from "./pages.js";
import { listMedia } from "./media.js";
import { listCategories, listTags, getSettings } from "./queries.js";
import type { SessionUser } from "./auth.js";
import { hasAnyUser } from "./auth.js";
import { db } from "./db.js";
import { users } from "./schema.js";
import { can } from "./admin.js";

type Ctx = { user?: SessionUser | null; [k: string]: unknown };

function requireUser(ctx: Ctx): SessionUser {
  if (!ctx.user) throw new ServiceError("未认证", 401);
  return ctx.user;
}

/** Login/setup pages: who am I, and does first-run setup still apply. */
export async function adminSession(_p: unknown, _ctx: Ctx) {
  return { user: _ctx.user ?? null, needsSetup: !(await hasAnyUser()) };
}

export async function adminDashboard(_p: unknown, ctx: Ctx) {
  return dashboardStats(requireUser(ctx));
}

export async function adminPosts(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  const page = Math.max(1, Number(p?.page) || 1);
  const limit = 50;
  const out = await adminListPosts(user, {
    status: p?.status || undefined,
    search: p?.search || undefined,
    limit,
    offset: (page - 1) * limit,
  });
  return { ...out, page, limit };
}

/** Editor data: one post (or null for "new") plus taxonomy option rows. */
export async function adminPost(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  const [categories, tags] = await Promise.all([listCategories(), listTags()]);
  const authors = can(user.role, "content:update:any")
    ? await db.select({ id: users.id, name: users.name }).from(users).orderBy(users.name)
    : [];
  if (p?.id === "new" || p?.id == null) return { post: null, categories, tags, authors };
  const post = await adminGetPost(user, Number(p.id));
  return { post, categories, tags, authors };
}

export async function adminPages(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  const page = Math.max(1, Number(p?.page) || 1);
  const limit = 50;
  const out = await adminListPages(user, {
    status: p?.status || undefined,
    limit,
    offset: (page - 1) * limit,
  });
  return { ...out, page, limit };
}

/** Editor data: one page (or null for "new"). */
export async function adminPage(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  if (p?.id === "new" || p?.id == null) return { page: null };
  return { page: await adminGetPage(user, Number(p.id)) };
}

/** Media library grid — newest first, up to 200 rows like the original. */
export async function adminMedia(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  return listMedia(user, 100, 0);
}

export async function adminComments(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  const page = Math.max(1, Number(p?.page) || 1);
  const limit = 50;
  const out = await adminListComments(user, {
    status: p?.status || undefined,
    limit,
    offset: (page - 1) * limit,
  });
  return { ...out, page, limit };
}

export async function adminTaxonomies(_p: unknown, ctx: Ctx) {
  requireUser(ctx);
  const [categories, tags] = await Promise.all([listCategories(), listTags()]);
  return { categories, tags };
}

export async function adminUsers(_p: unknown, ctx: Ctx) {
  return adminListUsers(requireUser(ctx));
}

export async function adminSettings(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (user.role !== "admin") throw new ServiceError("权限不足", 403);
  return getSettings();
}
