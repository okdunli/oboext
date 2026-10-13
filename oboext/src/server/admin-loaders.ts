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
  collectAdminMenuExtras,
  getAdminMenuPrefs,
  shellNavHtml,
} from "./admin-menu.js";
import { listCategories, listTags, getSettings } from "./queries.js";
import { listPlugins, getPlugin, ensurePluginsLoaded } from "./plugins.js";
import { getNotifySettings } from "./notify.js";
import { getMemberSettings } from "./members.js";
import { applyFilters, HOOKS } from "./hooks.js";
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
 *  Authed pages additionally receive the preference-driven sidebar nav
 *  (core groups + plugin hook entries + plugin panel links). */
export async function adminSession(_p: unknown, _ctx: Ctx) {
  const user = _ctx.user ?? null;
  const out: {
    user: SessionUser | null;
    needsSetup: boolean;
    homePath?: string;
    navRaw?: string;
  } = { user, needsSetup: !(await hasAnyUser()) };
  if (user) {
    const [prefs, extras] = await Promise.all([
      getAdminMenuPrefs(),
      collectAdminMenuExtras(),
    ]);
    out.homePath = prefs.homePath;
    out.navRaw = shellNavHtml(user.role, String(_ctx.pathname || ""), prefs, extras);
  }
  return out;
}

export async function adminMenuSettings(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const [prefs, extras] = await Promise.all([
    getAdminMenuPrefs(),
    collectAdminMenuExtras(),
  ]);
  return {
    groups: buildAdminMenuAll(extras),
    hiddenHrefs: prefs.hiddenHrefs,
    homePath: prefs.homePath,
  };
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

/**
 * Plugin-owned admin panel host (original parity: app/admin/plugins/[slug]).
 * Guards existence + activation (missing/disabled → { plugin: null }, the
 * page answers the segment 404), then lets the enabled plugin fill the
 * panel through the admin.panel filter: server-rendered `html` plus the URL
 * of an external `scriptSrc` (strict admin CSP: 'self' scripts only).
 * Plugins without a panel fall back to the host page's own hint.
 */
export async function adminPluginPanel(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const slug = String(p?.slug || "").trim();
  let plugin: Awaited<ReturnType<typeof getPlugin>> | null = null;
  try {
    plugin = await getPlugin(slug);
  } catch {
    return { plugin: null, html: "", scriptSrc: "" };
  }
  if (!plugin.enabled) return { plugin: null, html: "", scriptSrc: "" };
  await ensurePluginsLoaded();
  const out = applyFilters<{ slug: string; html: string; scriptSrc: string }>(HOOKS.adminPanel, {
    slug,
    html: "",
    scriptSrc: "",
  });
  return { plugin, html: out.html, scriptSrc: out.scriptSrc };
}

export async function adminNotify(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const s = await getNotifySettings();
  return {
    ...s,
    smtp: { ...s.smtp, pass: "" },
    sms: {
      ...s.sms,
      aliyun: { ...s.sms.aliyun, accessKeySecret: "" },
      tencent: { ...s.sms.tencent, secretKey: "" },
    },
  };
}

export async function adminMembers(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  return getMemberSettings();
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
