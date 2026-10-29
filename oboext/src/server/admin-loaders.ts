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
import { pageNum } from "./paging.js";
import { POST_FORMATS } from "./post-formats.js";
import { listMedia } from "./media.js";
import { listMenus, menuLabelDisplay } from "./menus.js";
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
  roleAllows,
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
import { listRedirects } from "./redirects.js";
import { getMaintenanceSettings } from "./maintenance.js";
import { getOption } from "./options.js";
import { listSecurityEvents } from "./security-events.js";
import { SITE_SETTINGS_SCHEMA } from "./site-settings-schema.js";
import { resolveSettings } from "./settings-schema.js";
import {
  visitSourcesToday,
  visitSourcesForPost,
  topPostsBySource,
  type VisitSourceRow,
  type SourcePostRow,
} from "./visit-sources.js";
import { REFERRER_KINDS } from "./referrer.js";
import { readdirSync } from "node:fs";
import path from "node:path";
import { applyAsyncFilters, applyFilters, HOOKS } from "./hooks.js";
import type { SessionUser } from "./auth.js";
import { hasAnyUser } from "./auth.js";
import { publicAssetHref } from "./theme-chrome.js";
import { db } from "./db.js";
import { comments, posts, users, searchTerms, webmentions } from "./schema.js";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { can } from "./admin.js";

// Newsletter admin screen (subscribers list). Kept to direct db reads here —
// the module itself avoids the content memo for the same reason: subscriber
// state is exact, live data, and the admin table must show it as-is.
import { rawQuery as rawQueryNewsletter } from "./db.js";
import { newsletterSends, subscribers } from "./schema.js";
import { ADMIN_RETRY_LIMIT } from "./newsletter.js";

/**
 * Privacy mask for the list column: keeps the first character of the local
 * part, hides the rest. `alice@example.com` -> `a***@example.com`. The full
 * address is never needed by the UI, so the loader never ships it.
 */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return email.slice(0, 1) + "***" + email.slice(at);
}

type Ctx = {
  user?: SessionUser | null;
  /** Parsed query string (URLSearchParams), set per request by the middleware. */
  query?: URLSearchParams;
  /** Accept-Language header, set per request by the middleware (installer i18n). */
  acceptLanguage?: string;
  [k: string]: unknown;
};


/**
 * R257: a staff-only staff screen. `content:read` is held by EVERY role —
 * including `subscriber`, which is the reader membership tier, not staff — so
 * gating a management screen on it let a logged-in reader open the newsletter
 * list, the search-terms report and this webmention inbox through /api/data.
 * These three screens had no reader-facing content at all; they exist for
 * people who run the site. Same rule admin.ts already uses for its own
 * membership checks: everyone except `subscriber` is staff.
 */
function requireStaff(user: SessionUser): void {
  if (user.role === "subscriber") throw new ServiceError("权限不足", 403);
}

/**
 * R259: the sidebar already decides who sees these screens - `adminOnly`
 * means admin || editor (admin-menu.ts roleAllows). The loader gates were one
 * notch looser (`requireStaff` = not a subscriber), so an AUTHOR could not see
 * the Comments menu yet read every comment thread on the site through
 * /api/data (measured: sees other posts' comments = true). One predicate,
 * imported from the menu, so the two can never disagree.
 */
function requireAdminOnly(user: SessionUser): void {
  if (!roleAllows(user.role, { adminOnly: true })) throw new ServiceError("权限不足", 403);
}

/**
 * R263: the `superOnly` half of the same predicate.
 *
 * The sidebar marks the whole "users & permissions" group superOnly (admin),
 * but `admin.users` only required `users:read` — which editor holds. Measured:
 * an editor could list every account INCLUDING the admin's email, while the
 * menu deliberately hides that screen from them. `publicUser` strips the
 * password hash and nothing else, so this is a PII leak, not a cosmetic drift.
 *
 * Same source of truth as requireAdminOnly - one predicate, two flags.
 */
function requireSuperOnly(user: SessionUser): void {
  if (!roleAllows(user.role, { superOnly: true })) throw new ServiceError("权限不足", 403);
}

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

export type AdminTrendDay = { d: string; posts: number; comments: number };

/** One row of the dashboard's 今日来源分布 card (R255). `kind` is one of
 *  referrer.ts REFERRER_KINDS plus the 'direct' bucket the rollup defaults to. */
export type AdminVisitSource = { kind: string; views: number; uniques: number };

/** One row of the dashboard's 来源 × 文章 table (R256): a channel's top post
 *  over the window, with its title for the link column. */
export type AdminSourcePost = { kind: string; postId: number; title: string; views: number };

/**
 * The 来源 × 文章 rows for one dashboard load: every stored referrer_kind in
 * parallel, flattened and re-sorted by views desc, capped so one busy channel
 * cannot stretch the table across the page.
 *
 * WHY 7 DAYS (not today): visit_daily is append-only day buckets - the rollup
 * rewrites today and yesterday and never deletes - so a week of rows is always
 * there, while a today-only window is empty on most days of a small site and
 * the table would almost never render. It also matches the 近 7 天趋势 card
 * above it, so the two windows on the same page agree.
 *
 * A missing visit_daily (pre-0041 restore) degrades to an empty table, exactly
 * like the `sources` leg below: every other number on the page still matters.
 */
async function adminTopSourcePosts(): Promise<AdminSourcePost[]> {
  const perKind = await Promise.all(
    REFERRER_KINDS.map((k) => topPostsBySource(k, 7, 5).catch(() => [] as SourcePostRow[])),
  );
  return perKind
    .flat()
    .sort((a, b) => b.views - a.views)
    .slice(0, 12);
}


/**
 * 近 7 天（含今天）文章/评论的每日新增，日期标签形如 "2026-10-20"，升序 7 项。
 * ISO 日期而非 "MM-DD"：跨年时 "MM-DD" 字符串不随时间升序，页面与测试都按
 * 字符串序读它。切日按服务器本地时区（JS Date 的本地日历日）进行 - timestamptz 列取回
 * 后由 Node 归日，不依赖数据库的 TimeZone 设置。posts 全部按 created_at
 * 归日；comments 只统计 status='published'。窗口外或缺失的日子补 0。
 */
async function adminDashboardTrends(): Promise<AdminTrendDay[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const label = (dt: Date) =>
    dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
  const [postRows, commentRows] = await Promise.all([
    db.select({ createdAt: posts.createdAt }).from(posts).where(gte(posts.createdAt, start)),
    db
      .select({ createdAt: comments.createdAt })
      .from(comments)
      .where(and(gte(comments.createdAt, start), eq(comments.status, "published"))),
  ]);
  const days: AdminTrendDay[] = [];
  const byDay = new Map<string, AdminTrendDay>();
  for (let i = 0; i < 7; i++) {
    const row: AdminTrendDay = {
      d: label(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)),
      posts: 0,
      comments: 0,
    };
    days.push(row);
    byDay.set(row.d, row);
  }
  const bump = (createdAt: unknown, key: "posts" | "comments") => {
    const row = byDay.get(label(new Date(createdAt as string | number | Date)));
    if (row) row[key] += 1;
  };
  for (const r of postRows) bump(r.createdAt, "posts");
  for (const r of commentRows) bump(r.createdAt, "comments");
  return days;
}

export async function adminDashboard(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  // The dashboardCards filter receives a bare { cards: [] } payload - no
  // dependency on stats - so both reads run in one wave. The 7-day trend
  // buckets are independent of both, so they ride the same wave. Same for the
  // traffic-source breakdown (R255) and its per-post drill-down (R256): indexed
  // reads of visit_daily, no dependency on any other leg.
  const [stats, filtered, trends, sources, topSourcePosts] = await Promise.all([
    dashboardStats(user),
    applyAsyncFilters<{ cards: DashboardCardItem[] }>(HOOKS.dashboardCards, { cards: [] }),
    adminDashboardTrends(),
    // A missing table (a database restored from a pre-0041 backup, an older
    // dist against a newer data dir) must degrade the card to "no data", not
    // fail the whole dashboard - every other number on the page still matters.
    visitSourcesToday().catch(() => [] as VisitSourceRow[]),
    // R256 drill-down: independent of every other leg (one range scan per
    // channel), so it rides the same wave instead of serialising behind it.
    adminTopSourcePosts(),
  ]);
  return {
    ...stats,
    cards: filtered.cards,
    trends,
    sources: sources as AdminVisitSource[],
    topSourcePosts,
  };
}

export async function adminPosts(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  const page = pageNum(p?.page);
  const limit = 50;
  const out = await adminListPosts(user, {
    status: p?.status || undefined,
    search: p?.search || undefined,
    locale: p?.locale || undefined,
    limit,
    offset: (page - 1) * limit,
    after: p?.after || undefined,
  });
  return { ...out, page, limit };
}

/**
 * R228: an id that resolves to nothing is a dead bookmark, not a server fault.
 * `adminGetPost`/`adminGetPage` already answer ServiceError(404), but a plain
 * server module has no error channel to a status, so the miss travels back as
 * `notFound: true` and the page's own `$data` throws the framework's
 * `notFound()` - which is where the compiler put that import. Every other
 * status (403 on another author's draft, 401) still propagates as before.
 */
function idMiss<T>(work: Promise<T>): Promise<T | undefined> {
  return work.catch((e) => {
    if (e instanceof ServiceError && e.status === 404) return undefined;
    throw e;
  });
}

/** Editor data: one post (or null for "new") plus taxonomy option rows. */
export async function adminPost(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  // Categories, tags, the author list and the post itself are mutually independent - one wave instead of the old three serial awaits (taxonomy pair).
  const authorsP = can(user.role, "content:update:any")
    ? db.select({ id: users.id, name: users.name }).from(users).orderBy(users.name)
    : Promise.resolve([]);
  if (p?.id === "new" || p?.id == null) {
    const [categories, tags, authors] = await Promise.all([listCategories(), listTags(), authorsP]);
    return { post: null, categories, tags, authors, formats: POST_FORMATS };
  }
  const [categories, tags, authors, post, postSources] = await Promise.all([
    listCategories(),
    listTags(),
    authorsP,
    idMiss(adminGetPost(user, Number(p.id))),
    // R256: 近 30 天来源摘要，只读 visit_daily；表缺失或查询失败时降级为
    // "不渲染摘要"，编辑器的其余数据一个都不能丢。
    visitSourcesForPost(Number(p.id)).catch(() => [] as VisitSourceRow[]),
  ]);
  if (!post) return { notFound: true };
  return { post, categories, tags, authors, formats: POST_FORMATS, postSources };
}

export async function adminPages(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  const page = pageNum(p?.page);
  const limit = 50;
  const out = await adminListPages(user, {
    status: p?.status || undefined,
    limit,
    offset: (page - 1) * limit,
    after: p?.after || undefined,
    sort: p?.sort === "order" ? "order" : undefined,
  });
  return { ...out, page, limit };
}

/** Editor data: one page (or null for "new"). */
export async function adminPage(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  if (p?.id === "new" || p?.id == null) return { page: null };
  const page = await idMiss(adminGetPage(user, Number(p.id)));
  return page ? { page } : { notFound: true };
}

/** Media library grid — newest first, service caps at 100 rows. */
export async function adminMedia(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  return listMedia(user, 100, 0);
}

/** Menu manager: every menu with its resolved item tree. Default items are
 *  stored as "@key" markers (see loaders.ts localizeMenu); the editor shows
 *  readable text and cleanItem re-encodes it on save. */
export async function adminMenus(_p: unknown, ctx: Ctx) {
  requireUser(ctx);
  requireSuperOnly(ctx.user!);
  const flags = (items: { label?: string; children?: unknown }[]): void => {
    items.forEach((it) => {
      it.label = menuLabelDisplay(String(it.label ?? ""));
      if (Array.isArray(it.children) && it.children.length) flags(it.children as typeof items);
    });
  };
  // "@key" markers and legacy zh defaults display as readable text; only the
  // seeded defaults are affected, admin labels pass through unchanged.
  const menus = await listMenus();
  menus.forEach((m) => flags(m.items as unknown as { label?: string; children?: unknown }[]));
  return { menus };
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

/** R193: the redirect rule table, newest first, for /admin/redirects. */
export async function adminRedirects(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  return { rows: await listRedirects() };
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
  const page = pageNum(q?.get("page") ?? (p as any)?.page);
  const type = String(q?.get("type") || (p as any)?.type || "").trim();
  const typePrefix = String(q?.get("typePrefix") || (p as any)?.typePrefix || "").trim();
  const account = String(q?.get("account") || (p as any)?.account || "").trim();
  const ip = String(q?.get("ip") || (p as any)?.ip || "").trim();
  const limit = 30;
  const out = await listSecurityEvents({
    limit,
    offset: (page - 1) * limit,
    eventType: type || undefined,
    typePrefix: typePrefix || undefined,
    account: account || undefined,
    ip: ip || undefined,
  });
  return {
    ...out,
    page,
    pages: Math.max(1, Math.ceil(out.total / limit)),
    type,
    typePrefix,
    account,
    ip,
  };
}

export async function adminIcons(_p: unknown, ctx: Ctx) {
  requireUser(ctx);
  requireSuperOnly(ctx.user!);
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
  requireAdminOnly(user);
  const page = pageNum(p?.page);
  const limit = 50;
  const out = await adminListComments(user, {
    status: p?.status || undefined,
    limit,
    offset: (page - 1) * limit,
    after: p?.after || undefined,
  });
  return { ...out, page, limit };
}

/**
 * Newsletter admin screen: the subscriber table (newest first, masked) plus
 * the header stat cards. The mask is applied in the loader — the full address
 * must never reach the browser for a column the UI never needs it for. The
 * session's locale picks the catalog, so the page binds ready-made strings.
 */
export async function adminNewsletter(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  requireAdminOnly(user);
  const page = pageNum(p?.page);
  const limit = 50;
  const locale = acceptLanguageLocale(ctx.acceptLanguage || "");
  const t = makeT(locale);
  const statQ = rawQueryNewsletter<{
    total: number | string;
    confirmed: number | string;
    unsubscribed: number | string;
  }>(
    `select
       count(*) as total,
       count(*) filter (where confirmed_at is not null and unsubscribed_at is null) as confirmed,
       count(*) filter (where unsubscribed_at is not null) as unsubscribed
     from subscribers`,
  );
  // The failure side of the ledger (newsletter_sends.failed_at, 0036): the
  // count drives the stat card and the retry button's visibility, the detail
  // rows are the last ADMIN_RETRY_LIMIT so the operator can see WHICH article
  // and address is stuck — that constant is also the admin endpoint's retry
  // budget, so one click works through exactly what this table listed.
  // Newest failure first (the screen opens on what just broke); the retry pass
  // itself works oldest-first, which is the right order for repairs.
  const failedCountQ = db
    .select({ n: sql<number>`count(*)` })
    .from(newsletterSends)
    .where(isNotNull(newsletterSends.failedAt));
  const failuresQ = db
    .select({
      title: posts.title,
      email: subscribers.email,
      failedAt: newsletterSends.failedAt,
    })
    .from(newsletterSends)
    .innerJoin(posts, eq(posts.id, newsletterSends.postId))
    .innerJoin(subscribers, eq(subscribers.id, newsletterSends.subscriberId))
    .where(isNotNull(newsletterSends.failedAt))
    .orderBy(desc(newsletterSends.failedAt))
    .limit(ADMIN_RETRY_LIMIT);
  const [rows, [stats], [failedRow], failureRows] = await Promise.all([
    db
      .select({
        id: subscribers.id,
        email: subscribers.email,
        locale: subscribers.locale,
        confirmedAt: subscribers.confirmedAt,
        unsubscribedAt: subscribers.unsubscribedAt,
        createdAt: subscribers.createdAt,
      })
      .from(subscribers)
      .orderBy(desc(subscribers.id))
      .limit(limit)
      .offset((page - 1) * limit),
    statQ,
    failedCountQ,
    failuresQ,
  ]);
  const items = rows.map((r) => ({
    id: r.id,
    email: maskEmail(r.email),
    locale: r.locale,
    // One derived state the page badges on: unsubscribed wins over confirmed —
    // an address that left the list must not display as an active one.
    status: r.unsubscribedAt ? "unsubscribed" : r.confirmedAt ? "confirmed" : "pending",
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
  }));
  // Same mask as the subscriber list: the failure table answers "which address
  // is stuck", and a masked tail is enough to answer it. The raw address never
  // leaves the server from here.
  const failures = failureRows.map((r) => ({
    title: r.title,
    email: maskEmail(r.email),
    failedAt: r.failedAt ? r.failedAt.toISOString() : null,
  }));
  return {
    items,
    total: Number(stats.total),
    confirmed: Number(stats.confirmed),
    unsubscribed: Number(stats.unsubscribed),
    failed: Number(failedRow?.n ?? 0),
    failures,
    page,
    limit,
    s: {
      title: t("newsletter.admin_title"),
      col_email: t("newsletter.admin_col_email"),
      col_locale: t("newsletter.admin_col_locale"),
      col_status: t("newsletter.admin_col_status"),
      col_created: t("newsletter.admin_col_created"),
      stat_total: t("newsletter.admin_stat_total"),
      stat_confirmed: t("newsletter.admin_stat_confirmed"),
      stat_unsub: t("newsletter.admin_stat_unsub"),
      stat_failed: t("newsletter.admin_failed"),
      badge_confirmed: t("newsletter.admin_badge_confirmed"),
      badge_pending: t("newsletter.admin_badge_pending"),
      badge_unsub: t("newsletter.admin_badge_unsub"),
      empty: t("newsletter.admin_empty"),
      hint_mask: t("newsletter.admin_hint_mask"),
      failed_lead: t("newsletter.admin_failed_lead"),
      no_failed: t("newsletter.admin_no_failed"),
      col_post: t("newsletter.admin_col_post"),
      col_failed_at: t("newsletter.admin_col_failed_at"),
      retry: t("newsletter.admin_retry"),
      retry_confirm: t("newsletter.admin_retry_confirm"),
      retry_done: t("newsletter.admin_retry_done"),
      retry_error: t("newsletter.admin_retry_error"),
    },
  };
}

export async function adminTaxonomies(_p: unknown, ctx: Ctx) {
  requireUser(ctx);
  requireStaff(ctx.user!);
  const [categories, tags] = await Promise.all([listCategories(), listTags()]);
  return { categories, tags };
}

export async function adminUsers(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  requireSuperOnly(user);
  return adminListUsers(user);
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
  // feed_full_text lives in the generic options store AND is mirrored by the
  // site_settings feedContent column (the save route keeps both in sync), so
  // the checkbox reflects the real feed behavior whichever end last saved.
  stored.feed_full_text =
    (await getOption<boolean>("feed_full_text", false)) === true ||
    stored.feedContent === "full";
  // webhook_url lives in the generic options store (webhook.ts reads it from
  // there) — site_settings has no such column — so inject it for the form the
  // same way feed_full_text is injected above.
  stored.webhook_url = await getOption<string>("webhook_url", "");
  return { settings: resolveSettings(schema, stored), schema };
}

export async function notFoundConfig(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (user.role !== "admin") throw new ServiceError("权限不足", 403);
  const { getNotFoundSettings } = await import("./not-found-config.js");
  return getNotFoundSettings();
}

/**
 * Hot search terms for /admin/search-terms: the whole table windowed by
 * (hits DESC, last_at DESC) — the exact order migration 0038's
 * search_terms_hits_last_idx carries, so the list is an index walk, not a
 * sort. Strings ride `s` from the catalog (the adminNewsletter pattern): the
 * page binds no keys of its own.
 */
export async function adminSearchTerms(p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  requireAdminOnly(user);
  const q = ctx.query as URLSearchParams | undefined;
  const page = pageNum(q?.get("page") ?? (p as { page?: unknown })?.page);
  const limit = 30;
  const locale = acceptLanguageLocale(ctx.acceptLanguage || "");
  const t = makeT(locale);
  const [rows, [tot]] = await Promise.all([
    db
      .select({
        id: searchTerms.id,
        term: searchTerms.term,
        locale: searchTerms.locale,
        hits: searchTerms.hits,
        lastAt: sql<string>`${searchTerms.lastAt}::text`,
      })
      .from(searchTerms)
      .orderBy(desc(searchTerms.hits), desc(searchTerms.lastAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ n: sql<number>`count(*)` }).from(searchTerms),
  ]);
  const total = Number(tot?.n ?? 0);
  return {
    items: rows,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    s: {
      title: t("searchterm.admin_title"),
      lead: t("searchterm.admin_lead"),
      col_term: t("searchterm.admin_col_term"),
      col_hits: t("searchterm.admin_col_hits"),
      col_locale: t("searchterm.admin_col_locale"),
      col_last: t("searchterm.admin_col_last"),
      empty: t("searchterm.admin_empty"),
    },
  };
}

/**
 * R257: the Webmention inbox. Reception (R255) already files each accepted
 * mention as a PENDING comment, so moderation *works* through the comments
 * queue - but that queue cannot show the two facts a moderator needs to judge
 * one: which site it came from and which URL it points at.
 *
 * Privacy: only the source HOST is exposed. A source URL can carry a private
 * path or a tracking query, and a moderator does not need it to decide; the
 * target is local and shown as its path.
 */
export async function adminWebmentions(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  requireAdminOnly(user);
  const t = makeT(acceptLanguageLocale(ctx));
  const page = pageNum(p?.page);
  const limit = 30;
  const status = String(p?.status || "").trim();
  const where =
    status && ["pending", "accepted", "rejected"].includes(status)
      ? eq(webmentions.status, status)
      : undefined;

  const [rows, counts] = await Promise.all([
    db
      .select({
        id: webmentions.id,
        source: webmentions.source,
        target: webmentions.target,
        status: webmentions.status,
        commentId: webmentions.commentId,
        createdAt: webmentions.createdAt,
        postTitle: posts.title,
      })
      .from(webmentions)
      .leftJoin(posts, eq(posts.id, webmentions.postId))
      .where(where)
      .orderBy(desc(webmentions.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ status: webmentions.status, n: sql<number>`count(*)::int` })
      .from(webmentions)
      .groupBy(webmentions.status),
  ]);

  const byStatus: Record<string, number> = { pending: 0, accepted: 0, rejected: 0 };
  for (const r of counts) byStatus[r.status] = r.n;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const hostOf = (u: string): string => {
    try {
      return new URL(u).host;
    } catch {
      return u.slice(0, 60);
    }
  };
  const pathOf = (u: string): string => {
    try {
      const x = new URL(u);
      return x.pathname + x.search;
    } catch {
      return u.slice(0, 120);
    }
  };

  return {
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil((status ? byStatus[status] : total) / limit)),
    status,
    counts: byStatus,
    items: rows.map((r) => ({
      id: r.id,
      sourceHost: hostOf(r.source),
      targetPath: pathOf(r.target),
      status: r.status,
      commentId: r.commentId,
      postTitle: r.postTitle ?? "",
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : "",
    })),
    s: {
      title: t("webmention.admin_title"),
      lead: t("webmention.admin_lead"),
      col_source: t("webmention.admin_col_source"),
      col_target: t("webmention.admin_col_target"),
      col_post: t("webmention.admin_col_post"),
      col_status: t("webmention.admin_col_status"),
      col_time: t("webmention.admin_col_time"),
      empty: t("webmention.admin_empty"),
      st_pending: t("webmention.admin_st_pending"),
      st_accepted: t("webmention.admin_st_accepted"),
      st_rejected: t("webmention.admin_st_rejected"),
      approve: t("webmention.admin_approve"),
      reject: t("webmention.admin_reject"),
      filter_all: t("webmention.admin_filter_all"),
    },
  };
}
