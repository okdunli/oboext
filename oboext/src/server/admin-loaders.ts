// Isomorphic read loaders for the admin pages.
import {
  dashboardStats,
  adminListPosts,
  adminGetPost,
  adminListComments,
  adminListUsers,
  ServiceError,
} from "./admin.js";
import { adminListPages, adminGetPage } from "./pages.js";
import { POST_FORMATS } from "./post-formats.js";
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
  type DashboardCardItem,
} from "./admin-menu.js";
import { listCategories, listTags, getSettings } from "./queries.js";
import { PUBLIC_DIR } from "./storage.js";
import { makeT, acceptLanguageLocale } from "./i18n.js";
import { listPlugins, getPlugin, ensurePluginsLoaded } from "./plugins.js";
import { getNotifySettings } from "./notify.js";
import { getMemberSettings } from "./members.js";
import { getAdminSecurity } from "./security.js";
import { getOwnProfile } from "./account.js";
import { isPasswordlessUser } from "./passwordless.js";
import { listAdminProviders, type AdminProvider } from "./oauth.js";
import { getPermalinkConfig } from "./links.js";
import { getMaintenanceSettings } from "./maintenance.js";
import { listSecurityEvents } from "./security-events.js";
import { SITE_SETTINGS_SCHEMA } from "./site-settings-schema.js";
import { resolveSettings } from "./settings-schema.js";
import { readdirSync } from "node:fs";
import path from "node:path";
import { applyAsyncFilters, applyFilters, HOOKS } from "./hooks.js";
import type { SessionUser } from "./auth.js";
import { hasAnyUser } from "./auth.js";
import { publicAssetHref } from "./theme-chrome.js";
import { db } from "./db.js";
import { users } from "./schema.js";
import { can } from "./admin.js";

type Ctx = {
  user?: SessionUser | null;
  /** Parsed query string (URLSearchParams), set per request by the middleware. */
  query?: URLSearchParams;
  [k: string]: unknown;
};

function requireUser(ctx: Ctx): SessionUser {
  if (!ctx.user) throw new ServiceError("未认证", 401);
  return ctx.user;
}

// Login/setup pages: who am I, and does first-run setup still apply.
/**
 * The first-run installer's strings, in the browser's language. No URL prefix
 * and no locale cookie exist before the first admin is created, so the
 * Accept-Language header (carried on ctx by the middleware) is the signal -
 * unless the URL already carries one: the middleware bounces the untagged
 * installer path to /admin/setup?l=<lang> so the prod hot cache (keyed on
 * pathname+cookie only, BUG.md AB) can never replay one browser's render to
 * another language. The tag therefore WINS over the header: the cache key and
 * the rendered language must agree, or a shared ?l=zh link would cache English
 * bytes under the Chinese key.
 */
export async function adminSetup(p: { l?: string } | undefined, ctx: Ctx) {
  const tag = String(p?.l ?? "").trim().toLowerCase();
  const locale =
    tag.startsWith("en")
      ? "en"
      : tag.startsWith("zh")
        ? "zh-CN"
        : acceptLanguageLocale(ctx.acceptLanguage || "");
  const t = makeT(locale);
  return {
    locale,
    s: {
      docTitle: t("setup.doc_title"),
      title: t("setup.title"),
      lead: t("setup.lead"),
      db: t("setup.db"),
      dbPglite: t("setup.db_pglite"),
      dbPostgres: t("setup.db_postgres"),
      dbPgliteHint: t("setup.db_pglite_hint"),
      dbUrl: t("setup.db_url"),
      storage: t("setup.storage"),
      storageLocal: t("setup.storage_local"),
      storageBlob: t("setup.storage_blob"),
      storageLocalHint: t("setup.storage_local_hint"),
      storageBlobHint: t("setup.storage_blob_hint"),
      blobToken: t("setup.blob_token"),
      site: t("setup.site"),
      siteTitle: t("setup.site_title"),
      siteDesc: t("setup.site_desc"),
      siteDescDefault: t("setup.site_desc_default"),
      tagline: t("setup.tagline"),
      footer: t("setup.footer"),
      admin: t("setup.admin"),
      email: t("setup.email"),
      name: t("setup.name"),
      namePh: t("setup.name_ph"),
      password: t("setup.password"),
      submit: t("setup.submit"),
      back: t("setup.back"),
    },
  };
}

export async function adminSession(_p: unknown, _ctx: Ctx) {
  const user = _ctx.user ?? null;
  const out: {
    user: SessionUser | null;
    needsSetup: boolean;
    homePath?: string;
    navRaw?: string;
    csrfHref: string;
    adminHref: string;
    autosaveHref: string;
  } = { user, needsSetup: !(await hasAnyUser()) };
  out.csrfHref = publicAssetHref("csrf.js");
  out.adminHref = publicAssetHref("admin.js");
  out.autosaveHref = publicAssetHref("autosave.js");
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
  const user = requireUser(ctx);
  // The dashboardCards filter receives a bare { cards: [] } payload - no
  // dependency on stats - so both reads run in one wave.
  const [stats, filtered] = await Promise.all([
    dashboardStats(user),
    applyAsyncFilters<{ cards: DashboardCardItem[] }>(HOOKS.dashboardCards, { cards: [] }),
  ]);
  return { ...stats, cards: filtered.cards };
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
    after: p?.after || undefined,
  });
  return { ...out, page, limit };
}

/** Editor data: one post (or null for "new") plus taxonomy option rows. */
export async function adminPost(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  // Categories, tags, the author list and the post itself are mutually independent - one wave instead of the old three serial awaits (taxonomy pair).
  const authorsP = can(user.role, "content:update:any")
    ? db.select({ id: users.id, name: users.name }).from(users).orderBy(users.name)
    : Promise.resolve([]);
  if (p?.id === "new" || p?.id == null) {
    const [categories, tags, authors] = await Promise.all([listCategories(), listTags(), authorsP]);
    return { post: null, categories, tags, authors, formats: POST_FORMATS };
  }
  const [categories, tags, authors, post] = await Promise.all([
    listCategories(),
    listTags(),
    authorsP,
    adminGetPost(user, Number(p.id)),
  ]);
  return { post, categories, tags, authors, formats: POST_FORMATS };
}

export async function adminPages(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  const page = Math.max(1, Number(p?.page) || 1);
  const limit = 50;
  const out = await adminListPages(user, {
    status: p?.status || undefined,
    limit,
    offset: (page - 1) * limit,
    after: p?.after || undefined,
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

// Plugin-owned admin panel host (original parity: app/admin/plugins/[slug]).
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

export async function adminAccount(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  const [profile, passwordless] = await Promise.all([
    getOwnProfile(user),
    isPasswordlessUser(user.id),
  ]);
  return { ...profile, role: user.role, passwordless };
}

export async function adminSecurity(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  return getAdminSecurity();
}

export async function adminSecurityPublic(_p: unknown, _ctx: Ctx) {
  const sec = await getAdminSecurity();
  return { entryEnabled: sec.entryEnabled };
}

export async function adminOAuth(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const providers = await listAdminProviders();
  const origin = typeof ctx.origin === "string" ? ctx.origin : "";
  const rows: Array<AdminProvider & { callbackUrl: string }> = providers.map((p) => ({
    ...p,
    callbackUrl: `${origin}/api/oauth/${encodeURIComponent(p.key)}/callback`,
  }));
  return { providers: rows };
}

export async function adminPermalinks(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  return getPermalinkConfig();
}

export async function adminMaintenance(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  return getMaintenanceSettings();
}

export async function adminSecurityLogs(p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const q = ctx.query as URLSearchParams | undefined;
  const page = Math.max(1, Number(q?.get("page") || (p as any)?.page) || 1);
  const type = String(q?.get("type") || (p as any)?.type || "").trim();
  const limit = 30;
  const out = await listSecurityEvents({
    limit,
    offset: (page - 1) * limit,
    eventType: type || undefined,
  });
  return { ...out, page, pages: Math.max(1, Math.ceil(out.total / limit)), type };
}

export async function adminIcons(_p: unknown, ctx: Ctx) {
  requireUser(ctx);
  const dir = path.join(PUBLIC_DIR, "icons");
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    names = [];
  }
  return { names };
}

/** Widget manager: areas, registered types and the selected theme's instances. */
export async function adminWidgets(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const q = String(p?.theme || ctx.query?.get("theme") || "").trim();
  // One wave: listThemes is independent of the active slug, and the widget
  // instances only need the slug choice - an explicit ?theme= starts the
  // read immediately, otherwise it chains off the active-slug promise.
  const activeP = getActiveThemeSlug();
  const widgetsP = (q ? Promise.resolve(q) : activeP).then((s) =>
    listWidgets(q || s || THEME_SLUG),
  );
  const [active, rows, widgets] = await Promise.all([activeP, listThemes(), widgetsP]);
  return {
    theme: q || active || THEME_SLUG,
    activeThemeSlug: active,
    themes: rows.map((t) => ({
      slug: t.slug,
      name: t.slug === active ? `${t.name}（当前启用）` : t.name,
    })),
    areas: WIDGET_AREAS,
    types: WIDGET_TYPES,
    widgets,
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
    after: p?.after || undefined,
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
  const [row, themeRows, pageOut] = await Promise.all([
    getSettings(),
    listThemes(),
    adminListPages(user, { limit: 200 }),
  ]);
  // Dynamic select options are injected here (installed themes, pages) so the
  // page itself stays a dumb schema renderer, mirroring the original
  // app/admin/settings/page.tsx. Both lists stay unfiltered: a stored value
  // that is missing from the options would silently fall back to the first
  // entry on save.
  const themeOptions = themeRows.map((t) => ({ value: t.slug, label: t.name }));
  const pageOptions = [
    { value: "", label: "— 未选择 —" },
    ...pageOut.items.map((p) => ({ value: String(p.id), label: p.title })),
  ];
  const schema = SITE_SETTINGS_SCHEMA.map((section) => ({
    ...section,
    fields: section.fields.map((f) =>
      f.key === "activeThemeSlug"
        ? { ...f, options: themeOptions }
        : f.key === "homePageId" || f.key === "postsPageId"
          ? { ...f, options: pageOptions }
          : f,
    ),
  }));
  // homePageId / postsPageId are integers; select values are strings, so
  // normalise to string on the way out and back to number on save.
  const stored: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of ["homePageId", "postsPageId"]) {
    stored[k] = stored[k] == null ? "" : String(stored[k]);
  }
  return { settings: resolveSettings(schema, stored), schema };
}

export async function notFoundConfig(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (user.role !== "admin") throw new ServiceError("权限不足", 403);
  const { getNotFoundSettings } = await import("./not-found-config.js");
  return getNotFoundSettings();
}
