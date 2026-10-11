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
import { listMenus } from "./menus.js";
import {
  THEME_SLUG,
  WIDGET_AREAS,
  WIDGET_TYPES,
  listWidgets,
} from "./widgets.js";
import {
  listThemes,
  getThemeMeta,
  getActiveThemeSlug,
  getThemePanel,
  isPublicThemePorted,
} from "./themes.js";
import {
  buildAdminMenuAll,
  getAdminMenuPrefs,
  shellNavHtml,
} from "./admin-menu.js";
import { listCategories, listTags, getSettings } from "./queries.js";
import { listPlugins, getPlugin } from "./plugins.js";
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

/** Login/setup pages: who am I, and does first-run setup still apply.
 *  Authed pages additionally receive the preference-driven sidebar nav. */
export async function adminSession(_p: unknown, _ctx: Ctx) {
  const user = _ctx.user ?? null;
  const out: {
    user: SessionUser | null;
    needsSetup: boolean;
    homePath?: string;
    navRaw?: string;
  } = { user, needsSetup: !(await hasAnyUser()) };
  if (user) {
    const prefs = await getAdminMenuPrefs();
    out.homePath = prefs.homePath;
    out.navRaw = shellNavHtml(user.role, String(_ctx.pathname || ""), prefs);
  }
  return out;
}

export async function adminMenuSettings(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const prefs = await getAdminMenuPrefs();
  return { groups: buildAdminMenuAll(), hiddenHrefs: prefs.hiddenHrefs, homePath: prefs.homePath };
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

/** Media library grid — newest first, service caps at 100 rows. */
export async function adminMedia(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  return listMedia(user, 100, 0);
}

/** Menu manager: every menu with its resolved item tree. */
export async function adminMenus(_p: unknown, ctx: Ctx) {
  requireUser(ctx);
  return { menus: await listMenus() };
}

/** Plugin manager: every on-disk plugin with its row + manifest. */
export async function adminPlugins(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  return { plugins: await listPlugins() };
}

/** One plugin: manifest settings schema + resolved values for the form. */
export async function adminPlugin(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  return getPlugin(String(p?.slug || ""));
}

/** Widget manager: areas, registered types and the selected theme's instances. */
export async function adminWidgets(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const q = String(p?.theme || ctx.query?.get("theme") || "").trim();
  const active = await getActiveThemeSlug();
  const slug = q || active || THEME_SLUG;
  const rows = await listThemes();
  return {
    theme: slug,
    activeThemeSlug: active,
    themes: rows.map((t) => ({
      slug: t.slug,
      name: t.slug === active ? `${t.name}（当前启用）` : t.name,
    })),
    areas: WIDGET_AREAS,
    types: WIDGET_TYPES,
    widgets: await listWidgets(slug),
  };
}

/** Theme manager: every on-disk theme with manifest meta + active flag. */
export async function adminThemes(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const [rows, activeSlug] = await Promise.all([listThemes(), getActiveThemeSlug()]);
  return {
    activeThemeSlug: activeSlug,
    themes: rows.map((t) => ({
      ...t,
      active: t.slug === activeSlug,
      ported: isPublicThemePorted(t.slug),
      meta: getThemeMeta(t.slug),
    })),
  };
}

/** Per-theme settings panel: both schemas, resolved values, widget areas. */
export async function adminThemePanel(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const slug = String(p?.slug || "").trim();
  if (!slug) throw new ServiceError("缺少主题标识", 422);
  return getThemePanel(slug);
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

export async function notFoundConfig(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (user.role !== "admin") throw new ServiceError("权限不足", 403);
  const { getNotFoundSettings } = await import("./not-found-config.js");
  return getNotFoundSettings();
}
