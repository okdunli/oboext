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
import { memoQuery } from "./cache.js";
import { pageNum } from "./paging.js";
import { POST_FORMATS } from "./post-formats.js";
import { localizePostFormats } from "./post-formats-en.js";
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
  localizeMenuGroups,
  collectAdminMenuExtras,
  getAdminMenuPrefs,
  roleAllows,
  shellNavHtml,
  type DashboardCardItem,
} from "./admin-menu.js";
import { listCategories, listTags, getSettings } from "./queries.js";
import { PUBLIC_DIR } from "./storage.js";
import {
  makeT,
  acceptLanguageLocale,
  ctxLocale,
  resolveLocale,
  pluginNameKey,
  pluginDescKey,
  type Translate,
} from "./i18n.js";
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
import { SETTINGS_EN } from "./site-settings-en.js";
import { localizeWidgetCatalog } from "./widgets-en.js";
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
import { comments, pages as pagesTable, posts, users, searchTerms, webmentions } from "./schema.js";
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { can } from "./admin.js";

// Newsletter admin screen (subscribers list). Kept to direct db reads here —
// the module itself avoids the content memo for the same reason: subscriber
// state is exact, live data, and the admin table must show it as-is.
import { rawQuery, rawQuery as rawQueryNewsletter } from "./db.js";
import { newsletterSends, subscribers } from "./schema.js";
import { ADMIN_RETRY_LIMIT } from "./newsletter.js";
import { siteDateContext, siteDayParts } from "./site-dates.js";

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
  /** Request locale, resolved by the middleware (prefix -> cookie -> header). */
  locale?: string;
  /** Raw Cookie header, set per request by the middleware. */
  cookie?: string;
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
/**
 * The request locale for an ADMIN screen. Admin paths carry no locale prefix
 * (only the public site is prefixed), so ctx.locale would always be the
 * default here - which would make every translated admin string inert. The
 * visitor's explicit cookie choice is the signal, then Accept-Language, then
 * the default.
 */
function adminLocale(ctx: Ctx) {
  return resolveLocale({
    url: ctx.pathname,
    cookie: ctx.cookie || "",
    accept: ctx.acceptLanguage || "",
  });
}

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
  // The shared client script (public/admin.js) prints its own notices, so the
  // session - the one payload every admin page loads - hands down the toast
  // block too, in the request's language. admin.js falls back to zh when the
  // block is absent (an older dist, a cached script).
  const locale = adminLocale(_ctx);
  const t = makeT(locale);
  const s: Record<string, string> = {};
  for (const k of ["notfound_saved", "profile_updated", "theme_installed", "variants_images_only", "members_saved", "cat_move_failed", "cat_move_failed_net", "variants_built", "variants_complete", "permalinks_saved", "icon_updated", "copy_failed", "security_saved", "password_updated", "linked_prefix", "saved", "saved_menu", "created", "deleted_n", "deleted", "enabled", "copied_n", "force_deleted_n", "updated_n", "updated", "file_replaced", "added", "variants_partial", "unlinked", "copy_unsupported", "restore_done", "bulk_done", "plugin_installed", "file_not_found", "variants_noneed", "icon_failed", "welcome_back", "scanning", "building_variants", "test_sent", "user_saved", "oauth_saved", "maintenance_saved", "oauth_created", "settings_saved", "select_first", "test_target_missing", "theme_name_missing", "tag_missing", "order_saved", "code_sent"]) {
    s[k] = t("admin.toast." + k);
  }
  const out: {
    user: SessionUser | null;
    needsSetup: boolean;
    homePath?: string;
    navRaw?: string;
    csrfHref: string;
    adminHref: string;
    adminCssHref: string;
    mediaPickerHref: string;
    twofaHref: string;
    oauthTwofaHref: string;
    usersHref: string;
    autosaveHref: string;
    liveHref: string;
    locale: string;
    toast: Record<string, string>;
    shell: Record<string, string | Record<string, string>>;
    login: Record<string, string>;
    export: Record<string, string>;
    backup: Record<string, string>;
  } = {
    user,
    locale,
    toast: s,
    shell: {
      docTitle: t("admin.shell.doc_title"),
      logoSuffix: t("admin.shell.logo_suffix"),
      closeNav: t("admin.shell.close_nav"),
      openNav: t("admin.shell.open_nav"),
      myAccount: t("admin.shell.my_account"),
      logout: t("admin.shell.logout"),
      visitSite: t("admin.shell.visit_site"),
      // The topbar heading is the sidebar's own word for the screen, so the
      // page title never disagrees with the nav. Edit/detail screens get the
      // one extra word a menu entry cannot carry.
      titles: {
        dash: t("admin.nav.dash"),
        content: t("admin.nav.content"),
        posts: t("admin.nav.posts"),
        postEdit: t("admin.title.edit_post"),
        pages: t("admin.nav.pages"),
        pageEdit: t("admin.title.edit_page"),
        media: t("admin.nav.media"),
        comments: t("admin.nav.comments"),
        categories: t("admin.nav.categories"),
        tags: t("admin.nav.tags"),
        users: t("admin.nav.users"),
        members: t("admin.nav.members"),
        widgets: t("admin.nav.widgets"),
        themes: t("admin.nav.themes"),
        themeDetail: t("admin.title.theme_detail"),
        menus: t("admin.nav.menus"),
        menuSettings: t("admin.nav.menu_settings"),
        settings: t("admin.nav.settings"),
        permalinks: t("admin.nav.permalinks"),
        redirects: t("admin.nav.redirects"),
        security: t("admin.nav.security"),
        securityLogs: t("admin.nav.security_logs"),
        maintenance: t("admin.nav.maintenance"),
        oauth: t("admin.nav.oauth"),
        email: t("admin.nav.email"),
        sms: t("admin.nav.sms"),
        account: t("admin.nav.account"),
        notfound: t("admin.nav.notfound"),
        backup: t("admin.nav.backup"),
        export: t("admin.nav.export"),
        icons: t("admin.nav.icons"),
        plugins: t("admin.nav.plugins"),
        newsletter: t("admin.nav.newsletter"),
        searchTerms: t("admin.nav.search_terms"),
        webmentions: t("admin.nav.webmentions"),
      },
    },
    login: {
      docTitle: t("admin.login.doc_title"),
      sub: t("admin.login.sub"),
    },
    export: {
      docTitle: t("admin.export.doc_title"),
      noscope: t("admin.export.noscope"),
      title: t("admin.export.title"),
      scope: t("admin.export.scope"),
      posts: t("admin.export.posts"),
      postsDesc: t("admin.export.posts_desc"),
      pages: t("admin.export.pages"),
      pagesDesc: t("admin.export.pages_desc"),
      comments: t("admin.export.comments"),
      commentsDesc: t("admin.export.comments_desc"),
      taxonomies: t("admin.export.taxonomies"),
      taxonomiesDesc: t("admin.export.taxonomies_desc"),
      siteSettings: t("admin.export.site_settings"),
      settingsDesc: t("admin.export.settings_desc"),
      format: t("admin.export.format"),
      jsonDesc: t("admin.export.json_desc"),
      markdownDesc: t("admin.export.markdown_desc"),
      wxrDesc: t("admin.export.wxr_desc"),
      listSep: t("admin.export.list_sep"),
      importDetail: t("admin.export.import_detail"),
      complement: t("admin.export.complement"),
      start: t("admin.export.start"),
      import: t("admin.export.import"),
      importNote: t("admin.export.import_note"),
      skipExisting: t("admin.export.skip_existing"),
      skipHint: t("admin.export.skip_hint"),
      overwrite: t("admin.export.overwrite"),
      overwriteHint: t("admin.export.overwrite_hint"),
      dryRun: t("admin.export.dry_run"),
      runImport: t("admin.export.run_import"),
      fmtZip: t("admin.export.fmt_zip"),
      fmtLabel: t("admin.export.fmt_label"),
      zipParsed: t("admin.export.zip_parsed"),
      zipSkipped: t("admin.export.zip_skipped"),
      skippedLabel: t("admin.export.skipped_label"),
      andMore: t("admin.export.and_more"),
      postsSummary: t("admin.export.posts_summary"),
      pagesSummary: t("admin.export.pages_summary"),
      commentsSummary: t("admin.export.comments_summary"),
      executed: t("admin.export.executed"),
      postsCreated: t("admin.export.posts_created"),
      postsOverwritten: t("admin.export.posts_overwritten"),
      postsSkipped: t("admin.export.posts_skipped"),
      pagesCreated: t("admin.export.pages_created"),
      commentsImported: t("admin.export.comments_imported"),
      catsCreated: t("admin.export.cats_created"),
      authorsAttributed: t("admin.export.authors_attributed"),
      authorsExceeded: t("admin.export.authors_exceeded"),
      failedN: t("admin.export.failed_n"),
      invalidItems: t("admin.export.invalid_items"),
      selectFile: t("admin.export.select_file"),
      confirmRun: t("admin.export.confirm_run"),
      processing: t("admin.export.processing"),
      importFailed: t("admin.export.import_failed"),
      unknownError: t("admin.export.unknown_error"),
      importRequestFailed: t("admin.export.import_request_failed"),
    },
    backup: {
      docTitle: t("admin.backup.doc_title"),
      title: t("admin.backup.title"),
      download: t("admin.backup.download"),
      downloadHint: t("admin.backup.download_hint"),
      full: t("admin.backup.full"),
      dbOnly: t("admin.backup.db_only"),
      restore: t("admin.backup.restore"),
      warn: t("admin.backup.warn"),
      fileLabel: t("admin.backup.file_label"),
      confirmLabel: t("admin.backup.confirm_label"),
      run: t("admin.backup.run"),
      afterHint: t("admin.backup.after_hint"),
    },
    needsSetup: !(await hasAnyUser()),
    csrfHref: publicAssetHref("csrf.js"),
    adminHref: publicAssetHref("admin.js"),
    adminCssHref: publicAssetHref("admin.css"),
    autosaveHref: publicAssetHref("autosave.js"),
    liveHref: publicAssetHref("admin-live.js"),
    mediaPickerHref: publicAssetHref("admin-media-picker.js"),
    twofaHref: publicAssetHref("account-twofa.js"),
    oauthTwofaHref: publicAssetHref("oauth-twofa.js"),
    usersHref: publicAssetHref("admin-users.js"),
  };
  if (user) {
    const [prefs, extras] = await Promise.all([
      getAdminMenuPrefs(),
      collectAdminMenuExtras(),
    ]);
    out.homePath = prefs.homePath;
    // The sidebar rides every admin page, so it speaks the request's language
    // too: built-in entries carry catalog markers, hook/plugin labels stay literal.
    out.navRaw = shellNavHtml(
      user.role,
      String(_ctx.pathname || ""),
      prefs,
      extras,
      makeT(adminLocale(_ctx)),
    );
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
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.menu_settings.doc_title"),
    title: t("admin.menu_settings.title"),
    intro: t("admin.menu_settings.intro"),
    extension: t("admin.menu_settings.extension"),
    locked: t("admin.menu_settings.locked"),
    currentHome: t("admin.menu_settings.current_home"),
    setHome: t("admin.menu_settings.set_home"),
    save: t("admin.menu_settings.save"),
  };
  return {
    groups: localizeMenuGroups(buildAdminMenuAll(extras), t),
    hiddenHrefs: prefs.hiddenHrefs,
    homePath: prefs.homePath,
    s,
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
  return memoQuery(`vsp:${new Date().toISOString().slice(0, 10)}`, 30_000, async () => {
    const perKind = await Promise.all(
      REFERRER_KINDS.map((k) => topPostsBySource(k, 7, 5).catch(() => [] as SourcePostRow[])),
    );
    return perKind
      .flat()
      .sort((a, b) => b.views - a.views)
      .slice(0, 12);
  });
}


/**
 * 近 7 天（含今天）文章/评论的每日新增，日期标签形如 "2026-10-20"，升序 7 项。
 * ISO 日期而非 "MM-DD"：跨年时 "MM-DD" 字符串不随时间升序，页面与测试都按
 * 字符串序读它。切日按站点时区设置（site_settings.timezone，IANA 名，默认
 * Asia/Shanghai）进行 - timestamptz 列取回后由 Node 归日，不依赖数据库的
 * TimeZone 设置。时区非法/缺失时回退服务器本地时区（R336 前的唯一行为）。
 * posts 全部按 created_at 归日；comments 只统计 status='published'。
 * 查询窗取 8 个 UTC 日（覆盖任何时区偏移，最大 ±14h），窗外的行由归日查表
 * 自然丢弃。窗口外或缺失的日子补 0。
 */

/** "YYYY-MM-DD" in `tz` (en-CA gives ISO-order parts); invalid/missing tz ->
 *  the SITE's default calendar (site-dates), never the server's wall clock
 *  (R534: the dashboard trend must agree with the rest of the app even when
 *  the configured zone name is a typo). */
export function zonedDayLabel(dt: Date, tz?: string | null): string {
  if (tz) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(dt);
    } catch {
      // fall through: an admin typo must not 500 the dashboard
    }
  }
  // R534: the fallback is the site's default calendar, not the server's.
  const { year, month, day } = siteDayParts(dt, siteDateContext().timezone);
  return `${year}-${month}-${day}`;
}

async function adminDashboardTrends(): Promise<AdminTrendDay[]> {
  // R559: the trend window changes only when content changes, so it rides the
  // same memo contract as the public listings — 30s TTL under `trend:`,
  // dropped by invalidateContentCaches on every write (the same list the
  // `lp:`/`sred:` families ride). The dashboard is the admin's first screen;
  // every visit used to re-run both 8-day-window reads even when nothing had
  // changed since the previous visit.
  const { timezone } = await getSettings();
  const tz = typeof timezone === "string" ? timezone.trim() : "";
  const today = new Date();
  const todayLabel = zonedDayLabel(today, tz);
  return memoQuery(`trend:${tz}:${todayLabel}`, 30_000, async () => {
  const start = new Date(Date.now() - 8 * 86_400_000);
  const [postRows, commentRows] = await Promise.all([
    db.select({ createdAt: posts.createdAt }).from(posts).where(gte(posts.createdAt, start)),
    db
      .select({ createdAt: comments.createdAt })
      .from(comments)
      .where(and(gte(comments.createdAt, start), eq(comments.status, "published"))),
  ]);
  const days: AdminTrendDay[] = [];
  const byDay = new Map<string, AdminTrendDay>();
  // The 7 labels walk back from the site-tz "today" in label space (UTC-anchored
  // day steps), so a +14h site never skips or duplicates a day at the seam.
  const anchor = new Date(`${todayLabel}T00:00:00Z`);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - i);
    const row: AdminTrendDay = { d: d.toISOString().slice(0, 10), posts: 0, comments: 0 };
    days.push(row);
    byDay.set(row.d, row);
  }
  const bump = (createdAt: unknown, key: "posts" | "comments") => {
    const row = byDay.get(zonedDayLabel(new Date(createdAt as string | number | Date), tz));
    if (row) row[key] += 1;
  };
  for (const r of postRows) bump(r.createdAt, "posts");
  for (const r of commentRows) bump(r.createdAt, "comments");
    return days;
  });
}

export async function adminDashboard(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  // The dashboard is the first screen a new operator sees, so it speaks the
  // request's language: the middleware already resolved prefix -> cookie ->
  // Accept-Language into ctx.locale, and this route is dynamic (never baked,
  // no render memo), so those bytes can never be replayed to another browser.
  const locale = adminLocale(ctx);
  const t = makeT(locale);
  const s = {
    docTitle: t("admin.dash.doc_title"),
    all: t("admin.dash.all"),
    firstRun: t("admin.dash.first_run"),
    firstRunLead: t("admin.dash.first_run_lead"),
    seed: t("admin.dash.seed"),
    seedOk: t("admin.dash.seed_ok"),
    seedFail: t("admin.dash.seed_fail"),
    postStatus: t("admin.dash.post_status"),
    writePost: t("admin.dash.write_post"),
    published: t("admin.status.published"),
    draft: t("admin.status.draft"),
    archived: t("admin.status.archived"),
    quickActions: t("admin.dash.quick_actions"),
    newPost: t("admin.dash.new_post"),
    reviewComments: t("admin.dash.review_comments"),
    auditLog: t("admin.dash.audit_log"),
    categories: t("admin.dash.categories"),
    settings: t("admin.dash.settings"),
    trends: t("admin.dash.trends"),
    chartPosts: t("admin.dash.chart_posts"),
    chartComments: t("admin.dash.chart_comments"),
    trendsHint: t("admin.dash.trends_hint"),
    posts: t("admin.dash.posts"),
    comments: t("admin.dash.comments"),
    sources: t("admin.dash.sources"),
    sourcesHint: t("admin.dash.sources_hint"),
    sourcesByPost: t("admin.dash.sources_by_post"),
    sourcesByPostHint: t("admin.dash.sources_by_post_hint"),
    channel: t("admin.dash.channel"),
    postTitle: t("admin.dash.post_title"),
    views: t("admin.dash.views"),
    recentPosts: t("admin.dash.recent_posts"),
    recentComments: t("admin.dash.recent_comments"),
    title: t("admin.dash.title"),
    status: t("admin.dash.status"),
    updated: t("admin.dash.updated"),
    time: t("admin.dash.time"),
    api: t("admin.dash.api"),
    apiLead: t("admin.dash.api_lead"),
    apiPlayground: t("admin.dash.api_playground"),
    apiFeeds: t("admin.dash.api_feeds"),
    apiSitemap: t("admin.dash.api_sitemap"),
    visits: t("admin.dash.visits"),
    visitors: t("admin.dash.visitors"),
    commentApproved: t("admin.comment_status.published"),
    commentPending: t("admin.comment_status.pending"),
    commentSpam: t("admin.comment_status.spam"),
    srcSearch: t("admin.dash.src_search"),
    srcSocial: t("admin.dash.src_social"),
    srcInternal: t("admin.dash.src_internal"),
    srcDirect: t("admin.dash.src_direct"),
    srcOther: t("admin.dash.src_other"),
    pages: t("admin.dash.pages"),
    media: t("admin.dash.media"),
    tags: t("admin.dash.tags"),
    users: t("admin.dash.users"),
    pendingUnit: t("admin.dash.pending_unit"),
    tipPosts: t("admin.dash.tip_posts"),
    tipComments: t("admin.dash.tip_comments"),
  };
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
    locale,
    s,
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
  // Same contract as the dashboard (R485): the page renders copy(), never a
  // literal, so /en/posts is English without a second template.
  const locale = adminLocale(ctx);
  const t = makeT(locale);
  // R273/R543: the pair rows ride out of adminListPosts itself (fetched in
  // parallel with the taxonomy ids there), so this loader issues NO extra
  // query — the list's "↔ slug" column is pure mapping now.
  const postPairRows = out.pairRows;
  const postById = new Map(postPairRows.map((r) => [r.id, r]));
  const postItems = out.items.map((r) => {
    const other = r.translationOf != null ? postById.get(r.translationOf) : postPairRows.find((x) => x.translationOf === r.id);
    return { ...r, pair: other ? { id: other.id, slug: other.slug, locale: other.locale } : null };
  });
  const s = {
    docTitle: t("admin.posts.doc_title"),
    filterAll: t("admin.posts.filter_all"),
    published: t("admin.status.published"),
    draft: t("admin.status.draft"),
    archived: t("admin.status.archived"),
    languageAll: t("admin.posts.language_all"),
    languageZh: t("admin.posts.language_zh"),
    write: t("admin.posts.write"),
    searchPlaceholder: t("admin.posts.search_placeholder"),
    bulkPublish: t("admin.posts.bulk_publish"),
    bulkDraft: t("admin.posts.bulk_draft"),
    bulkArchive: t("admin.posts.bulk_archive"),
    bulkDelete: t("admin.posts.bulk_delete"),
    confirmBulkDelete: t("admin.posts.confirm_bulk_delete"),
    confirmDeleteOne: t("admin.posts.confirm_delete_one"),
    colTitle: t("admin.posts.col_title"),
    colAuthor: t("admin.posts.col_author"),
    colLanguage: t("admin.posts.col_language"),
    colStatus: t("admin.posts.col_status"),
    colDate: t("admin.posts.col_date"),
    colViews: t("admin.posts.col_views"),
    actView: t("admin.posts.act_view"),
    actEdit: t("admin.posts.act_edit"),
    actDelete: t("admin.posts.act_delete"),
    empty: t("admin.posts.empty"),
    pagerPrev: t("admin.common.prev"),
    pagerNext: t("admin.common.next"),
    pagerSummary: t("admin.posts.pager_summary"),
    scheduled: t("admin.posts.scheduled"),
  };
  return { ...out, items: postItems, page, limit, locale, s };
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
  const t = makeT(adminLocale(ctx));
  const s = {
    srcSearch: t("admin.editor.src_search"),
    srcSocial: t("admin.editor.src_social"),
    srcInternal: t("admin.editor.src_internal"),
    srcDirect: t("admin.editor.src_direct"),
    srcOther: t("admin.editor.src_other"),
    statusPublished: t("admin.editor.status_published"),
    statusDraft: t("admin.editor.status_draft"),
    statusArchived: t("admin.editor.status_archived"),
    confirmBroadcast: t("admin.editor.confirm_broadcast"),
    broadcastFailed: t("admin.editor.broadcast_failed"),
    broadcastQueued: t("admin.editor.broadcast_queued"),
    broadcastDone: t("admin.editor.broadcast_done"),
    broadcastNoNew: t("admin.editor.broadcast_no_new"),
    broadcastFailed2: t("admin.editor.broadcast_failed2"),
    historyLoadFailed: t("admin.editor.history_load_failed"),
    untitled: t("admin.editor.untitled"),
    rollbackTo: t("admin.editor.rollback_to"),
    rollbackToNamed: t("admin.editor.rollback_to_named"),
    untitled2: t("admin.editor.untitled2"),
    rollbackNote: t("admin.editor.rollback_note"),
    rollbackFailed: t("admin.editor.rollback_failed"),
    loadEarlier: t("admin.editor.load_earlier"),
    serverDraftFound: t("admin.editor.server_draft_found"),
    draftSavedAgo: t("admin.editor.draft_saved_ago"),
    draftNewer: t("admin.editor.draft_newer"),
    restoreDraft: t("admin.editor.restore_draft"),
    ignore: t("admin.editor.ignore"),
    draftRestored: t("admin.editor.draft_restored"),
    restoreFailed: t("admin.editor.restore_failed"),
    generateFailed: t("admin.editor.generate_failed"),
    copyPreview: t("admin.editor.copy_preview"),
    previewCopied: t("admin.editor.preview_copied"),
    previewValid: t("admin.editor.preview_valid"),
    generateFailed2: t("admin.editor.generate_failed2"),
    editPostTitle: t("admin.editor.edit_post_title"),
    backToPosts: t("admin.editor.back_to_posts"),
    viewPost: t("admin.editor.view_post"),
    previewLink: t("admin.editor.preview_link"),
    confirmDelete: t("admin.editor.confirm_delete"),
    newsletterSend: t("admin.editor.newsletter_send"),
    saveDraft: t("admin.editor.save_draft"),
    save: t("admin.editor.save"),
    publish: t("admin.editor.publish"),
    permalink: t("admin.editor.permalink"),
    bodyBlocks: t("admin.editor.body_blocks"),
    blocksHint: t("admin.editor.blocks_hint"),
    blockParagraph: t("admin.editor.block_paragraph"),
    blockHeading: t("admin.editor.block_heading"),
    blockImage: t("admin.editor.block_image"),
    blockQuote: t("admin.editor.block_quote"),
    blockCode: t("admin.editor.block_code"),
    blockList: t("admin.editor.block_list"),
    blockDivider: t("admin.editor.block_divider"),
    status: t("admin.editor.status"),
    comments: t("admin.editor.comments"),
    author: t("admin.editor.author"),
    authorSelf: t("admin.editor.author_self"),
    featuredImageUrl: t("admin.editor.featured_image_url"),
    pickMedia: t("admin.editor.pick_media"),
    postFormat: t("admin.editor.post_format"),
    cardColor: t("admin.editor.card_color"),
    apply: t("admin.editor.apply"),
    detectFromImage: t("admin.editor.detect_from_image"),
    clear: t("admin.editor.clear"),
    cardColorHint: t("admin.editor.card_color_hint"),
    pinned: t("admin.editor.pinned"),
    categories: t("admin.editor.categories"),
    tags: t("admin.editor.tags"),
    translation: t("admin.editor.translation"),
    langZh: t("admin.editor.lang_zh"),
    langEn: t("admin.editor.lang_en"),
    customFields: t("admin.editor.custom_fields"),
    addField: t("admin.editor.add_field"),
    kvForThemes: t("admin.editor.kv_for_themes"),
    revisions: t("admin.editor.revisions"),
    revisionsHint: t("admin.editor.revisions_hint"),
    sources30d: t("admin.editor.sources_30d"),
    sourcesHint: t("admin.editor.sources_hint"),
    excerptPlaceholder: t("admin.editor.excerpt_placeholder"),
    translationIdPh: t("admin.editor.translation_id_ph"),
    seoDesc: t("admin.editor.seo_desc"),
    seoKeywords: t("admin.editor.seo_keywords"),
    standard: t("admin.editor.standard"),
    genericDelete: t("admin.editor.generic_delete"),
    genericSave: t("admin.editor.generic_save"),
    titlePhFull: t("admin.editor.title_ph_full"),
    slugPhFull: t("admin.editor.slug_ph_full"),
    excerptPhFull: t("admin.editor.excerpt_ph_full"),
    translationIdPhFull: t("admin.editor.translation_id_ph_full"),
    noHistory: t("admin.editor.no_history"),
    publishedAt: t("admin.editor.published_at"),
    scheduleHint: t("admin.editor.schedule_hint"),
    commentsOpen: t("admin.editor.comments_open"),
    commentsClosed: t("admin.editor.comments_closed"),
    pinnedDesc: t("admin.editor.pinned_desc"),
    noCatHint: t("admin.editor.no_cat_hint"),
    translationHint: t("admin.editor.translation_hint"),
    sourcesViews: t("admin.editor.sources_views"),
    sourcesVisitors: t("admin.editor.sources_visitors"),
    colorPick: t("admin.editor.color_pick"),
  };
  // Categories, tags, the author list and the post itself are mutually independent - one wave instead of the old three serial awaits (taxonomy pair).
  const authorsP = can(user.role, "content:update:any")
    ? db.select({ id: users.id, name: users.name }).from(users).orderBy(users.name)
    : Promise.resolve([]);
  if (p?.id === "new" || p?.id == null) {
    const [categories, tags, authors] = await Promise.all([listCategories(), listTags(), authorsP]);
    return { post: null, categories, tags, authors, formats: localizePostFormats(adminLocale(ctx) === "en"), s };
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
  return { post, categories, tags, authors, formats: localizePostFormats(adminLocale(ctx) === "en"), postSources, s };
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
  // Same contract as the dashboard / post list / comment queue (R485-R488).
  const locale = adminLocale(ctx);
  const t = makeT(locale);
  // 0046/R544: the pair rows ride out of adminListPages itself (the same
  // parallel-pair shape the posts list uses), so this loader issues NO extra
  // query — the "↔ slug" column is pure mapping now.
  const pairRows = out.pairRows;
  const byId = new Map(pairRows.map((r) => [r.id, r]));
  const items = out.items.map((r) => {
    const other = r.translationOf != null ? byId.get(r.translationOf) : pairRows.find((x) => x.translationOf === r.id);
    return {
      ...r,
      pair: other ? { id: other.id, slug: other.slug, locale: other.locale } : null,
    };
  });
  const s = {
    docTitle: t("admin.pages.doc_title"),
    filterAll: t("admin.pages.filter_all"),
    published: t("admin.status.published"),
    draft: t("admin.status.draft"),
    archived: t("admin.status.archived"),
    write: t("admin.pages.write"),
    sortHint: t("admin.pages.sort_hint"),
    bulkPublish: t("admin.pages.bulk_publish"),
    bulkDraft: t("admin.pages.bulk_draft"),
    bulkArchive: t("admin.pages.bulk_archive"),
    bulkDelete: t("admin.pages.bulk_delete"),
    confirmBulkDelete: t("admin.pages.confirm_bulk_delete"),
    colTitle: t("admin.pages.col_title"),
    colStatus: t("admin.pages.col_status"),
    colOrder: t("admin.pages.col_order"),
    colUpdated: t("admin.pages.col_updated"),
    actView: t("admin.pages.act_view"),
    actEdit: t("admin.pages.act_edit"),
    actDelete: t("admin.pages.act_delete"),
    empty: t("admin.pages.empty"),
    pagerPrev: t("admin.common.prev"),
    pagerNext: t("admin.common.next"),
    sortByUpdated: t("admin.pages.sort_by_updated"),
    sortByOrder: t("admin.pages.sort_by_order"),
    confirmDeleteOne: t("admin.pages.confirm_delete_one"),
    pagerSummary: t("admin.pages.pager_summary"),
  };
  return { ...out, items, page, limit, locale, s };
}

/** Editor data: one page (or null for "new"). */
export async function adminPage(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  const t = makeT(adminLocale(ctx));
  const s = {
    editPageTitle: t("admin.page_editor.edit_page_title"),
    backToPages: t("admin.page_editor.back_to_pages"),
    viewPage: t("admin.page_editor.view_page"),
    confirmDeletePage: t("admin.page_editor.confirm_delete_page"),
    parentPage: t("admin.page_editor.parent_page"),
    parentPagePh: t("admin.page_editor.parent_page_ph"),
    order: t("admin.page_editor.order"),
    orderHint: t("admin.page_editor.order_hint"),
    featuredImage: t("admin.page_editor.featured_image"),
    pickMedia: t("admin.editor.pick_media"),
    previewLink: t("admin.page_editor.preview_link"),
    contentLocale: t("admin.page_editor.content_locale"),
    translation: t("admin.editor.translation"),
    translationIdPh: t("admin.page_editor.translation_id_ph"),
    translationHint: t("admin.page_editor.translation_hint"),
    langZh: t("admin.editor.lang_zh"),
    langEn: t("admin.editor.lang_en"),
    confirmDeletePageFull: t("admin.page_editor.confirm_delete_page_full"),
    titlePhPage: t("admin.page_editor.title_ph_page"),
    slugPhPage: t("admin.page_editor.slug_ph_page"),
    parentPhFull: t("admin.page_editor.parent_ph_full"),
    // shared with the post editor
    save: t("admin.editor.save"),
    saveDraft: t("admin.editor.save_draft"),
    publish: t("admin.editor.publish"),
    permalink: t("admin.editor.permalink"),
    bodyBlocks: t("admin.editor.body_blocks"),
    blocksHint: t("admin.editor.blocks_hint"),
    status: t("admin.editor.status"),
    publishTime: t("admin.editor.publish_time"),
    scheduledHint: t("admin.editor.scheduled_hint"),
    comments: t("admin.editor.comments"),
    commentsOpen: t("admin.editor.comments_open"),
    commentsClosed: t("admin.editor.comments_closed"),
    customFields: t("admin.editor.custom_fields"),
    addField: t("admin.editor.add_field"),
    revisions: t("admin.editor.revisions"),
    revisionsHint: t("admin.editor.revisions_hint"),
    genericSave: t("admin.editor.generic_save"),
    genericDelete: t("admin.editor.generic_delete"),
    titlePhFull: t("admin.editor.title_ph_full"),
    slugPhFull: t("admin.editor.slug_ph_full"),
    excerptPhFull: t("admin.editor.excerpt_ph_full"),
    seoTitle: t("admin.editor.seo_title"),
    seoDesc: t("admin.editor.seo_desc"),
    seoKeywords: t("admin.editor.seo_keywords"),
    statusPublished: t("admin.status.published"),
    statusDraft: t("admin.status.draft"),
    statusArchived: t("admin.status.archived"),
    blockParagraph: t("admin.editor.block_paragraph"),
    blockHeading: t("admin.editor.block_heading"),
    blockImage: t("admin.editor.block_image"),
    blockQuote: t("admin.editor.block_quote"),
    blockCode: t("admin.editor.block_code"),
    blockList: t("admin.editor.block_list"),
    blockDivider: t("admin.editor.block_divider"),
    // the editor script reads these the same way the post editor does
    historyLoadFailed: t("admin.editor.history_load_failed"),
    noHistory: t("admin.editor.no_history"),
    untitled: t("admin.editor.untitled"),
    rollbackTo: t("admin.editor.rollback_to"),
    rollbackToNamed: t("admin.editor.rollback_to_named"),
    untitled2: t("admin.editor.untitled2"),
    rollbackNote: t("admin.editor.rollback_note"),
    rollbackFailed: t("admin.editor.rollback_failed"),
    loadEarlier: t("admin.editor.load_earlier"),
    serverDraftFound: t("admin.editor.server_draft_found"),
    draftSavedAgo: t("admin.editor.draft_saved_ago"),
    draftNewer: t("admin.editor.draft_newer"),
    restoreDraft: t("admin.editor.restore_draft"),
    ignore: t("admin.editor.ignore"),
    draftRestored: t("admin.editor.draft_restored"),
    restoreFailed: t("admin.editor.restore_failed"),
    generateFailed: t("admin.editor.generate_failed"),
    copyPreview: t("admin.editor.copy_preview"),
    previewCopied: t("admin.editor.preview_copied"),
    previewValid: t("admin.editor.preview_valid"),
  };
  if (p?.id === "new" || p?.id == null) return { page: null, s };
  const page = await idMiss(adminGetPage(user, Number(p.id)));
  return page ? { page, s } : { notFound: true, s };
}

/** Media library grid — newest first, service caps at 100 rows. */
export async function adminMedia(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  requireStaff(user);
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.media.doc_title"),
    bulkPrefix: t("admin.media.bulk_prefix"),
    uploadHint: t("admin.media.upload_hint"),
    pasteHint: t("admin.media.paste_hint"),
    altLabel: t("admin.media.alt_label"),
    upload: t("admin.media.upload"),
    selectAll: t("admin.media.select_all"),
    filterAll: t("admin.media.filter_all"),
    filterImages: t("admin.media.filter_images"),
    filterNonImages: t("admin.media.filter_non_images"),
    selected: t("admin.media.selected"),
    selectedN: t("admin.media.selected_n"),
    copyLinks: t("admin.media.copy_links"),
    tag: t("admin.media.tag"),
    variants: t("admin.media.variants"),
    syncBtn: t("admin.media.sync_btn"),
    titleSync: t("admin.media.title_sync"),
    syncDone: t("admin.media.sync_done"),
    syncNone: t("admin.media.sync_none"),
    bulkDelete: t("admin.media.bulk_delete"),
    loadMore: t("admin.media.load_more"),
    empty: t("admin.media.empty"),
    emptyHint: t("admin.media.empty_hint"),
    editTitle: t("admin.media.edit_title"),
    editAlt: t("admin.media.edit_alt"),
    editTags: t("admin.media.edit_tags"),
    editFile: t("admin.media.edit_file"),
    cancel: t("admin.media.cancel"),
    save: t("admin.media.save"),
    openFile: t("admin.media.open_file"),
    bulkTag: t("admin.media.bulk_tag"),
    tagAppend: t("admin.media.tag_append"),
    tagOverwrite: t("admin.media.tag_overwrite"),
    phAlt: t("admin.media.ph_alt"),
    typeFilter: t("admin.media.type_filter"),
    phSearch: t("admin.media.ph_search"),
    phTags: t("admin.media.ph_tags"),
    titleCopyAll: t("admin.media.title_copy_all"),
    titleBulkTag: t("admin.media.title_bulk_tag"),
    titleVariants: t("admin.media.title_variants"),
    titleDrag: t("admin.media.title_drag"),
    titleView: t("admin.media.title_view"),
    titleCopy: t("admin.media.title_copy"),
    titleEdit: t("admin.media.title_edit"),
    titleReplace: t("admin.media.title_replace"),
    confirmDelete: t("admin.media.confirm_delete"),
    titleDelete: t("admin.media.title_delete"),
    close: t("admin.media.close"),
    phBulkTags: t("admin.media.ph_bulk_tags"),
    phTagsEdit: t("admin.media.ph_tags_edit"),
  };
  const rows = await listMedia(user, 100, 0);
  return { ...rows, s };
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
  const locale = adminLocale(ctx);
  const t = makeT(locale);
  const s = {
    docTitle: t("admin.menus.doc_title"),
    autosave: t("admin.menus.autosave"),
    customLink: t("admin.menus.custom_link"),
    fromPosts: t("admin.menus.from_posts"),
    fromPages: t("admin.menus.from_pages"),
    fromCategories: t("admin.menus.from_categories"),
    fromTags: t("admin.menus.from_tags"),
    empty: t("admin.menus.empty"),
    addItem: t("admin.menus.add_item"),
    phLabel: t("admin.menus.ph_label"),
    phUrl: t("admin.menus.ph_url"),
    phIcon: t("admin.menus.ph_icon"),
    typeLabel: t("admin.menus.type_label"),
    refLabel: t("admin.menus.ref_label"),
    setIcon: t("admin.menus.set_icon"),
    moveUp: t("admin.menus.move_up"),
    moveDown: t("admin.menus.move_down"),
    indent: t("admin.menus.indent"),
    outdent: t("admin.menus.outdent"),
    delete: t("admin.common.delete"),
  };
  return { menus, s };
}

/** Plugin manager: every on-disk plugin with its row + manifest. */
export async function adminPlugins(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.plugins.doc_title"),
    title: t("admin.plugins.title"),
    upload: t("admin.plugins.upload"),
    fileMissing: t("admin.plugins.file_missing"),
    home: t("admin.plugins.home"),
    settings: t("admin.plugins.settings"),
    panel: t("admin.plugins.panel"),
    enabled: t("admin.plugins.enabled"),
    disabled: t("admin.plugins.disabled"),
    enable: t("admin.plugins.enable"),
    disable: t("admin.plugins.disable"),
    installedUnit: t("admin.plugins.installed_unit"),
    authorLabel: t("admin.plugins.author_label"),
    pluginWord: t("admin.plugins.plugin_word"),
    manage: t("admin.plugins.manage"),
    saveVerb: t("admin.plugins.save_verb"),
    adminSuffix: t("admin.plugins.admin_suffix"),
    empty: t("admin.plugins.empty"),
    uploadHint: t("admin.plugins.upload_hint"),
    settingsTitle: t("admin.plugins.settings_title"),
    cancel: t("admin.plugins.cancel"),
    save: t("admin.plugins.save"),
    adminPanel: t("admin.plugins.admin_panel"),
    close: t("admin.plugins.close"),
  };
  // R531: the plugin list shows the catalog's name/description when the
  // catalog has them (first-party plugins), and the manifest's otherwise
  // (third-party plugins are never renamed by the core).
  const plugins = (await listPlugins()).map((p) => {
    const nk = pluginNameKey(p.slug);
    const dk = pluginDescKey(p.slug);
    return {
      ...p,
      name: nk ? t(nk) : p.name,
      description: dk ? t(dk) : p.description,
    };
  });
  return { plugins, s };
}

/** One plugin: manifest settings schema + resolved values for the form. */
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
  // R531: the panel payload carries the request's translator so plugins render
  // their server-side panel HTML in the admin session's language (the same
  // makeT the surrounding shell copy uses).
  const t = makeT(adminLocale(ctx));
  const out = applyFilters<{ slug: string; html: string; scriptSrc: string; t: Translate }>(
    HOOKS.adminPanel,
    { slug, html: "", scriptSrc: "", t },
  );
  // R531: the panel header shows the plugin's name/description - the
  // catalog's when it has them, the manifest's otherwise.
  const nk = pluginNameKey(plugin.slug);
  const dk = pluginDescKey(plugin.slug);
  const view = {
    ...plugin,
    name: nk ? t(nk) : plugin.name,
    description: dk ? t(dk) : plugin.description,
  };
  return { plugin: view, html: out.html, scriptSrc: out.scriptSrc };
}

export async function adminNotify(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const settings = await getNotifySettings();
  const t = makeT(adminLocale(ctx));
  // One loader serves both the email screen and the SMS screen, so the copy
  // block carries both pages' strings; each template reads what it needs.
  const copy = {
    email: {
      docTitle: t("admin.email.doc_title"),
      title: t("admin.email.title"),
      save: t("admin.email.save"),
      lead: t("admin.email.lead"),
      smtp: t("admin.email.smtp"),
      host: t("admin.email.host"),
      port: t("admin.email.port"),
      encryption: t("admin.email.encryption"),
      tls: t("admin.email.tls"),
      starttls: t("admin.email.starttls"),
      none: t("admin.email.none"),
      username: t("admin.email.username"),
      password: t("admin.email.password"),
      from: t("admin.email.from"),
      fromPh: t("admin.email.from_ph"),
      channel: t("admin.email.channel"),
      enabled: t("admin.email.enabled"),
      enabledHint: t("admin.email.enabled_hint"),
      delivery: t("admin.email.delivery"),
      smtpDirect: t("admin.email.smtp_direct"),
      webhook: t("admin.email.webhook"),
      webhookUrl: t("admin.email.webhook_url"),
      method: t("admin.email.method"),
      bodyTemplate: t("admin.email.body_template"),
      bodyHint: t("admin.email.body_hint"),
      headers: t("admin.email.headers"),
      test: t("admin.email.test"),
      codeSwitch: t("admin.email.code_switch"),
      requireVerify: t("admin.email.require_verify"),
      allowLogin: t("admin.email.allow_login"),
      loginNote: t("admin.email.login_note"),
    },
    sms: {
      docTitle: t("admin.sms.doc_title"),
      title: t("admin.sms.title"),
      save: t("admin.sms.save"),
      lead: t("admin.sms.lead"),
      channel: t("admin.sms.channel"),
      enabled: t("admin.sms.enabled"),
      delivery: t("admin.sms.delivery"),
      provider: t("admin.sms.provider"),
      webhook: t("admin.sms.webhook"),
      aliyun: t("admin.sms.aliyun"),
      tencent: t("admin.sms.tencent"),
      sign: t("admin.sms.sign"),
      webhookUrl: t("admin.sms.webhook_url"),
      method: t("admin.sms.method"),
      bodyTemplate: t("admin.sms.body_template"),
      signHint: t("admin.sms.sign_hint"),
      bodyHint: t("admin.sms.body_hint"),
      headers: t("admin.sms.headers"),
      accessKeySecret: t("admin.sms.access_key_secret"),
      signName: t("admin.sms.sign_name"),
      templateCode: t("admin.sms.template_code"),
      templateVar: t("admin.sms.template_var"),
      endpoint: t("admin.sms.endpoint"),
      secretKey: t("admin.sms.secret_key"),
      templateId: t("admin.sms.template_id"),
      region: t("admin.sms.region"),
      endpoint2: t("admin.sms.endpoint2"),
      test: t("admin.sms.test"),
      codeSwitch: t("admin.sms.code_switch"),
      requireVerify: t("admin.sms.require_verify"),
      allowLogin: t("admin.sms.allow_login"),
      loginNote: t("admin.sms.login_note"),
    },
  };
  return {
    ...settings,
    smtp: { ...settings.smtp, pass: "" },
    sms: {
      ...settings.sms,
      aliyun: { ...settings.sms.aliyun, accessKeySecret: "" },
      tencent: { ...settings.sms.tencent, secretKey: "" },
    },
    copy,
  };
}

export async function adminMembers(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const settings = await getMemberSettings();
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.members.doc_title"),
    title: t("admin.members.title"),
    save: t("admin.members.save"),
    openHint: t("admin.members.open_hint"),
    open: t("admin.members.open"),
    offHint: t("admin.members.off_hint"),
    path: t("admin.members.path"),
    pathRule: t("admin.members.path_rule"),
    pathConflict: t("admin.members.path_conflict"),
    fields: t("admin.members.fields"),
    nameRequired: t("admin.members.name_required"),
    nameOff: t("admin.members.name_off"),
    passwordRequired: t("admin.members.password_required"),
    passwordOff: t("admin.members.password_off"),
    emailRequired: t("admin.members.email_required"),
    emailOff: t("admin.members.email_off"),
    phoneRequired: t("admin.members.phone_required"),
    phoneOff: t("admin.members.phone_off"),
    captcha: t("admin.members.captcha"),
    captchaHint: t("admin.members.captcha_hint"),
    inviteOn: t("admin.members.invite_on"),
    inviteHint: t("admin.members.invite_hint"),
    inviteCodes: t("admin.members.invite_codes"),
    inviteHint2: t("admin.members.invite_hint2"),
    defaultRole: t("admin.members.default_role"),
    roleSubscriber: t("admin.members.role_subscriber"),
    roleAuthor: t("admin.members.role_author"),
    codeNote: t("admin.members.code_note"),
  };
  return { ...settings, s };
}

export async function adminAccount(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  const [profile, passwordless] = await Promise.all([
    getOwnProfile(user),
    isPasswordlessUser(user.id),
  ]);
  // Same contract as every other admin screen (R485-R492).
  const locale = adminLocale(ctx);
  const t = makeT(locale);
  const s = {
    docTitle: t("admin.account.doc_title"),
    title: t("admin.account.title"),
    lead: t("admin.account.lead"),
    navGroup: t("admin.account.nav_group"),
    navProfile: t("admin.account.nav_profile"),
    navPassword: t("admin.account.nav_password"),
    navOauth: t("admin.account.nav_oauth"),
    nickname: t("admin.account.nickname"),
    emailCodeLabel: t("admin.account.email_code_label"),
    sendCode: t("admin.account.send_code"),
    phoneLabel: t("admin.account.phone_label"),
    phEmailCode: t("admin.account.ph_email_code"),
    phPhoneCode: t("admin.account.ph_phone_code"),
    saveProfile: t("admin.account.save_profile"),
    role: t("admin.account.role"),
    currentPassword: t("admin.account.current_password"),
    newPassword: t("admin.account.new_password"),
    confirmPassword: t("admin.account.confirm_password"),
    updatePassword: t("admin.account.update_password"),
    passwordlessHint: t("admin.account.passwordless_hint"),
    oauthLoading: t("admin.account.oauth_loading"),
  };
  return { ...profile, role: user.role, passwordless, locale, s };
}

export async function adminSecurity(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const settings = await getAdminSecurity();
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.security.doc_title"),
    title: t("admin.security.title"),
    save: t("admin.common.save_changes"),
    disguise: t("admin.security.disguise"),
    disguiseHint: t("admin.security.disguise_hint"),
    secretPath: t("admin.security.secret_path"),
    secretRule: t("admin.security.secret_rule"),
    secretBackup: t("admin.security.secret_backup"),
    captchaOn: t("admin.security.captcha_on"),
    captchaHint: t("admin.security.captcha_hint"),
    captchaChannel: t("admin.security.captcha_channel"),
    captchaBuiltin: t("admin.security.captcha_builtin"),
    captchaThird: t("admin.security.captcha_third"),
    reqMethod: t("admin.security.req_method"),
    reqHeaders: t("admin.security.req_headers"),
    successRule: t("admin.security.success_rule"),
    rateLimit: t("admin.security.rate_limit"),
    rateHint: t("admin.security.rate_hint"),
    maxFail: t("admin.security.max_fail"),
    windowMin: t("admin.security.window_min"),
    rateNote: t("admin.security.rate_note"),
    verifyUrl: t("admin.security.verify_url"),
    bodyTemplate: t("admin.security.body_template"),
  };
  return { ...settings, s };
}

export async function adminSecurityPublic(_p: unknown, _ctx: Ctx) {
  const sec = await getAdminSecurity();
  return { entryEnabled: sec.entryEnabled };
}

export async function adminOAuth(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const providers = await listAdminProviders(adminLocale(ctx));
  const origin = typeof ctx.origin === "string" ? ctx.origin : "";
  const rows: Array<AdminProvider & { callbackUrl: string }> = providers.map((p) => ({
    ...p,
    callbackUrl: `${origin}/api/oauth/${encodeURIComponent(p.key)}/callback`,
  }));
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.oauth.doc_title"),
    title: t("admin.oauth.title"),
    lead: t("admin.oauth.lead"),
    bindHint: t("admin.oauth.bind_hint"),
    callbackLabel: t("admin.oauth.callback_label"),
    verifiedMerge: t("admin.oauth.verified_merge"),
    verifiedMerge2: t("admin.oauth.verified_merge2"),
    custom: t("admin.oauth.custom"),
    delete: t("admin.oauth.delete"),
    enable: t("admin.oauth.enable"),
    clientId: t("admin.oauth.client_id"),
    clientSecret: t("admin.oauth.client_secret"),
    displayName: t("admin.oauth.display_name"),
    authorizeUrl: t("admin.oauth.authorize_url"),
    tokenUrl: t("admin.oauth.token_url"),
    userinfoUrl: t("admin.oauth.userinfo_url"),
    scope: t("admin.oauth.scope"),
    tokenMethod: t("admin.oauth.token_method"),
    tokenPost: t("admin.oauth.token_post"),
    clientCredentials: t("admin.oauth.client_credentials"),
    reqBodyFields: t("admin.oauth.req_body_fields"),
    userinfoToken: t("admin.oauth.userinfo_token"),
    bearer: t("admin.oauth.bearer"),
    queryParam: t("admin.oauth.query_param"),
    fieldMapping: t("admin.oauth.field_mapping"),
    fieldMapping2: t("admin.oauth.field_mapping2"),
    fieldId: t("admin.oauth.field_id"),
    fieldName: t("admin.oauth.field_name"),
    fieldAvatar: t("admin.oauth.field_avatar"),
    fieldEmail: t("admin.oauth.field_email"),
    fieldEmailVerified: t("admin.oauth.field_email_verified"),
    allowNew: t("admin.oauth.allow_new"),
    allowNewHint: t("admin.oauth.allow_new_hint"),
    mergeVerified: t("admin.oauth.merge_verified"),
    mergeHint: t("admin.oauth.merge_hint"),
    save: t("admin.oauth.save"),
    addTitle: t("admin.oauth.add_title"),
    slugHint: t("admin.oauth.slug_hint"),
    slug: t("admin.oauth.slug"),
    name: t("admin.oauth.name"),
    authorizeUrlReq: t("admin.oauth.authorize_url_req"),
    tokenUrlReq: t("admin.oauth.token_url_req"),
    userinfoUrlReq: t("admin.oauth.userinfo_url_req"),
    fieldIdReq: t("admin.oauth.field_id_req"),
    create: t("admin.oauth.create"),
    createNote: t("admin.oauth.create_note"),
    titleDelete: t("admin.oauth.title_delete"),
    phEmailEmpty: t("admin.oauth.ph_email_empty"),
    phEmailVerified: t("admin.oauth.ph_email_verified"),
    phSlug: t("admin.oauth.ph_slug"),
    phName: t("admin.oauth.ph_name"),
    stDisabled: t("admin.oauth.st_disabled"),
    stEnabled: t("admin.oauth.st_enabled"),
    stIncomplete: t("admin.oauth.st_incomplete"),
    stSecret: t("admin.oauth.st_secret"),
    stMissing: t("admin.oauth.st_missing"),
  };
  return { providers: rows, s };
}

export async function adminPermalinks(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const cfg = await getPermalinkConfig();
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.permalinks.doc_title"),
    title: t("admin.permalinks.title"),
    save: t("admin.common.save_changes"),
    preview: t("admin.permalinks.preview"),
    postsIndex: t("admin.permalinks.posts_index"),
    postExample: t("admin.permalinks.post_example"),
    staticPage: t("admin.permalinks.static_page"),
    category: t("admin.permalinks.category"),
    tag: t("admin.permalinks.tag"),
    rootNote: t("admin.permalinks.root_note"),
    postForm: t("admin.permalinks.post_form"),
    formSlug: t("admin.permalinks.form_slug"),
    formId: t("admin.permalinks.form_id"),
    formPinyin: t("admin.permalinks.form_pinyin"),
    formInitial: t("admin.permalinks.form_initial"),
    formCustom: t("admin.permalinks.form_custom"),
    customTokens: t("admin.permalinks.custom_tokens"),
    prefix: t("admin.permalinks.prefix"),
    prefixPosts: t("admin.permalinks.prefix_posts"),
    prefixPages: t("admin.permalinks.prefix_pages"),
    prefixCategories: t("admin.permalinks.prefix_categories"),
    prefixTags: t("admin.permalinks.prefix_tags"),
    prefixRule: t("admin.permalinks.prefix_rule"),
    tokenHint: t("admin.permalinks.token_hint"),
  };
  return { ...cfg, s };
}

/** R193: the redirect rule table, newest first, for /admin/redirects. */
export async function adminRedirects(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.redirects.doc_title"),
    addRule: t("admin.redirects.add_rule"),
    oldPath: t("admin.redirects.old_path"),
    newUrl: t("admin.redirects.new_url"),
    type: t("admin.redirects.type"),
    perm301: t("admin.redirects.perm301"),
    temp302: t("admin.redirects.temp302"),
    ruleNote: t("admin.redirects.rule_note"),
    bulkDelete: t("admin.redirects.bulk_delete"),
    colOld: t("admin.redirects.col_old"),
    colNew: t("admin.redirects.col_new"),
    colType: t("admin.redirects.col_type"),
    colSource: t("admin.redirects.col_source"),
    colHits: t("admin.redirects.col_hits"),
    colCreated: t("admin.redirects.col_created"),
    colActions: t("admin.redirects.col_actions"),
    empty: t("admin.redirects.empty"),
    confirmBulk: t("admin.redirects.confirm_bulk"),
    viewTarget: t("admin.redirects.view_target"),
    auto: t("admin.redirects.auto"),
    manual: t("admin.redirects.manual"),
    confirmDelete: t("admin.redirects.confirm_delete"),
    addFailed: t("admin.redirects.add_failed"),
    unknownError: t("admin.redirects.unknown_error"),
    requestFailed: t("admin.redirects.request_failed"),
    delete: t("admin.common.delete"),
    selectAll: t("admin.common.select_all"),
  };
  return { rows: await listRedirects(), s };
}

export async function adminMaintenance(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const settings = await getMaintenanceSettings();
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.maintenance.doc_title"),
    phDefault: t("admin.maintenance.ph_default"),
    title: t("admin.maintenance.title"),
    save: t("admin.common.save_changes"),
    closeSite: t("admin.maintenance.close_site"),
    closeHint: t("admin.maintenance.close_hint"),
    apisHint: t("admin.maintenance.apis_hint"),
    pageTitle: t("admin.maintenance.page_title"),
    colTitle: t("admin.maintenance.col_title"),
    colBody: t("admin.maintenance.col_body"),
    bodyHint: t("admin.maintenance.body_hint"),
    phTitle: t("admin.maintenance.ph_title"),
    phBody: t("admin.maintenance.ph_body"),
  };
  return { ...settings, s };
}

export async function adminSecurityLogs(p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.seclogs.doc_title"),
    title: t("admin.seclogs.title"),
    filterAll: t("admin.seclogs.filter_all"),
    loginOk: t("admin.seclogs.login_ok"),
    loginFail: t("admin.seclogs.login_fail"),
    loginLock: t("admin.seclogs.login_lock"),
    loginChallenge: t("admin.seclogs.login_challenge"),
    resetRequest: t("admin.seclogs.reset_request"),
    resetDone: t("admin.seclogs.reset_done"),
    typePrefix: t("admin.seclogs.type_prefix"),
    adminPrefix: t("admin.seclogs.admin_prefix"),
    filter: t("admin.seclogs.filter"),
    clear: t("admin.seclogs.clear"),
    colTime: t("admin.seclogs.col_time"),
    colEvent: t("admin.seclogs.col_event"),
    colAccount: t("admin.seclogs.col_account"),
    colUa: t("admin.seclogs.col_ua"),
    empty: t("admin.seclogs.empty"),
    pagerPrev: t("admin.seclogs.pager_prev"),
    pagerNext: t("admin.seclogs.pager_next"),
    phAccount: t("admin.seclogs.ph_account"),
    accountFilter: t("admin.seclogs.account_filter"),
    phIp: t("admin.seclogs.ph_ip"),
    ipFilter: t("admin.seclogs.ip_filter"),
    seeThisAccount: t("admin.seclogs.see_this_account"),
    totalLabel: t("admin.page.total_label"),
    countUnit: t("admin.seclogs.count_unit"),
    pagePrefix: t("admin.page.page_prefix"),
    pageSuffix: t("admin.page.page_suffix"),
    userHash: t("admin.page.user_hash"),
    seeThisIp: t("admin.seclogs.see_this_ip"),
    stage: t("admin.seclogs.stage"),
  };
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
  s,
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
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.icons.doc_title"),
    totalLabel: t("admin.page.total_label"),
    countUnit: t("admin.icons.count_unit"),
    title: t("admin.icons.title"),
    source: t("admin.icons.source"),
    colIcon: t("admin.icons.col_icon"),
    colName: t("admin.icons.col_name"),
    colComponent: t("admin.icons.col_component"),
    copy: t("admin.icons.copy"),
    empty: t("admin.icons.empty"),
    browse: t("admin.icons.browse"),
    phSearch: t("admin.icons.ph_search"),
    copyName: t("admin.icons.copy_name"),
  };
  return { names, s };
}

/** Widget manager: areas, registered types and the selected theme's instances. */
export async function adminWidgets(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.widgets.doc_title"),
    title: t("admin.widgets.title"),
    introArea: t("admin.widgets.intro_area"),
    introArea2: t("admin.widgets.intro_area2"),
    introArea3: t("admin.widgets.intro_area3"),
    introPanel: t("admin.widgets.intro_panel"),
    introPanel2: t("admin.widgets.intro_panel2"),
    introPanel3: t("admin.widgets.intro_panel3"),
    configTheme: t("admin.widgets.config_theme"),
    perTheme: t("admin.widgets.per_theme"),
    areaEmpty: t("admin.widgets.area_empty"),
    pickType: t("admin.widgets.pick_type"),
    add: t("admin.widgets.add"),
    moveUp: t("admin.widgets.move_up"),
    moveDown: t("admin.widgets.move_down"),
    settings: t("admin.widgets.settings"),
    delete: t("admin.widgets.delete"),
    cancel: t("admin.widgets.cancel"),
    hide: t("admin.widgets.hide"),
    show: t("admin.widgets.show"),
    currentSuffix: t("admin.widgets.current_suffix"),
    countSuffix: t("admin.widgets.count_suffix"),
    countSuffixOne: t("admin.widgets.count_suffix_one"),
  };
  const q = String(p?.theme || ctx.query?.get("theme") || "").trim();
  // One wave: listThemes is independent of the active slug, and the widget
  // instances only need the slug choice - an explicit ?theme= starts the
  // read immediately, otherwise it chains off the active-slug promise.
  const activeP = getActiveThemeSlug();
  const widgetsP = (q ? Promise.resolve(q) : activeP).then((s) =>
    listWidgets(q || s || THEME_SLUG),
  );
  const [active, rows, widgets] = await Promise.all([activeP, listThemes(), widgetsP]);
  // The widget catalogue is authored in Chinese inside widgets.ts; the English
  // names come from WIDGET_EN keyed by the source string (same shape as
  // SETTINGS_EN). Labels reach the page through the loader only, so one pass
  // covers every reader.
  const catalog = localizeWidgetCatalog(adminLocale(ctx) === "en");
  return {
    theme: q || active || THEME_SLUG,
    activeThemeSlug: active,
    themes: rows.map((th) => ({
      slug: th.slug,
      name: th.slug === active ? th.name + s.currentSuffix : th.name,
    })),
    areas: catalog.areas,
    types: catalog.types,
    widgets,
    s,
  };
}

/** Theme manager: every on-disk theme with manifest meta + active flag. */
export async function adminThemes(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const [rows, activeSlug] = await Promise.all([listThemes(), getActiveThemeSlug()]);
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.themes.doc_title"),
    updatedPrefix: t("admin.themes.updated_prefix"),
    title: t("admin.themes.title"),
    intro1: t("admin.themes.intro1"),
    intro2: t("admin.themes.intro2"),
    intro3: t("admin.themes.intro3"),
    newTheme: t("admin.themes.new_theme"),
    uploadTitle: t("admin.themes.upload_title"),
    uploadHint: t("admin.themes.upload_hint"),
    active: t("admin.themes.active"),
    adapting: t("admin.themes.adapting"),
    setActive: t("admin.themes.set_active"),
    adaptingShort: t("admin.themes.adapting_short"),
    themeSettings: t("admin.themes.theme_settings"),
    delete: t("admin.themes.delete"),
    phName: t("admin.themes.ph_name"),
    titleAdapting: t("admin.themes.title_adapting"),
    titleAdaptingShort: t("admin.themes.title_adapting_short"),
    builtin: t("admin.themes.builtin"),
  };
  return {
    activeThemeSlug: activeSlug,
    themes: rows.map((th) => ({
      ...th,
      active: th.slug === activeSlug,
      ported: isPublicThemePorted(th.slug),
      meta: getThemeMeta(th.slug),
    })),
    s,
  };
}

/** Per-theme settings panel: both schemas, resolved values, widget areas. */
export async function adminThemePanel(p: any, ctx: Ctx) {
  const user = requireUser(ctx);
  if (!can(user.role, "settings:manage")) throw new ServiceError("权限不足", 403);
  const slug = String(p?.slug || "").trim();
  if (!slug) throw new ServiceError("缺少主题标识", 422);
  const tt = makeT(adminLocale(ctx));
  const ts = {
    docTitle: tt("admin.themes_detail.doc_title"),
    back: tt("admin.themes_detail.back"),
    enabled: tt("admin.themes_detail.enabled"),
    reset: tt("admin.themes_detail.reset"),
    save: tt("admin.themes_detail.save"),
    appearance: tt("admin.themes_detail.appearance"),
    themeOptions: tt("admin.themes_detail.theme_options"),
    widgetAreas: tt("admin.themes_detail.widget_areas"),
    goWidgets: tt("admin.themes_detail.go_widgets"),
    preview: tt("admin.themes_detail.preview"),
    phTitle: tt("admin.themes_detail.ph_title"),
    phSubtitle: tt("admin.themes_detail.ph_subtitle"),
    button: tt("admin.themes_detail.button"),
  };
const panel = await getThemePanel(slug);
  // ts was built but never returned - the detail page read p.ts.* and 500ed.
  // The panel copy (customDesc/customBadge) lives here, not in themes.ts: the
  // theme module has no business carrying UI strings.
  return { ...panel, ts, s: { ...(panel.s ?? {}), customDesc: tt("admin.themepanel.custom_desc"), customBadge: tt("admin.themepanel.custom_badge") } };
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
  // Same contract as the dashboard and the post list (R485/R487).
  const locale = adminLocale(ctx);
  const t = makeT(locale);
  const s = {
    docTitle: t("admin.comments.doc_title"),
    filterAll: t("admin.comments.filter_all"),
    total: t("admin.comments.total"),
    bulkApprove: t("admin.comments.bulk_approve"),
    bulkSpam: t("admin.comments.bulk_spam"),
    bulkDelete: t("admin.comments.bulk_delete"),
    colAuthor: t("admin.comments.col_author"),
    colComment: t("admin.comments.col_comment"),
    colPost: t("admin.comments.col_post"),
    colStatus: t("admin.comments.col_status"),
    colDate: t("admin.comments.col_date"),
    actApprove: t("admin.comments.act_approve"),
    actPending: t("admin.comments.act_pending"),
    actSpam: t("admin.comments.act_spam"),
    actDelete: t("admin.comments.act_delete"),
    anonymous: t("admin.comments.anonymous"),
    empty: t("admin.comments.empty"),
    pagerPage: t("admin.comments.pager_page"),
    pagerPrev: t("admin.common.prev"),
    pagerNext: t("admin.common.next"),
    published: t("admin.comment_status.published"),
    pending: t("admin.comment_status.pending"),
    spam: t("admin.comment_status.spam"),
  };
  return { ...out, page, limit, locale, s };
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
    totalLabel: t("admin.page.total_label"),
    countUnit: t("admin.newsletter.count_unit"),
    pagePrefix: t("admin.page.page_prefix"),
    pageSuffix: t("admin.page.page_suffix"),
    localeZh: t("admin.newsletter.locale_zh"),
      title: t("newsletter.admin_title"),
      docTitle: t("newsletter.admin_title"),
      pagerPrev: t("admin.common.prev"),
      pagerNext: t("admin.common.next"),
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
  // One loader feeds both taxonomy screens (categories + tags), so the copy
  // block carries both pages' strings; each template reads what it needs
  // (R485-R490 contract).
  const locale = adminLocale(ctx);
  const t = makeT(locale);
  const s = {
    save: t("admin.common.save"),
    cancel: t("admin.common.cancel"),
    delete: t("admin.common.delete"),
    view: t("admin.common.view"),
    close: t("admin.common.close"),
    selectAll: t("admin.common.select_all"),
    name: t("admin.common.name"),
    slug: t("admin.common.slug"),
    description: t("admin.common.description"),
    actions: t("admin.common.actions"),
    edit: t("admin.common.edit"),
    slugKeep: t("admin.common.slug_keep"),
    add: t("admin.common.add"),
    icon: t("admin.common.icon"),
    // categories
    catDocTitle: t("admin.categories.doc_title"),
    slugOptional: t("admin.common.slug_optional"),
    catParent: t("admin.categories.parent"),
    catNoneTop: t("admin.categories.none_top"),
    catDescOptional: t("admin.categories.desc_optional"),
    catIconOptional: t("admin.categories.icon_optional"),
    catBulkDelete: t("admin.categories.bulk_delete"),
    catEmpty: t("admin.categories.empty"),
    catEditTitle: t("admin.categories.edit_title"),
    catPhName: t("admin.categories.ph_name"),
    catPhSlug: t("admin.categories.ph_slug"),
    catPhDesc: t("admin.categories.ph_desc"),
    catPhIcon: t("admin.categories.ph_icon"),
    catConfirmBulk: t("admin.categories.confirm_bulk"),
    catTitleIcon: t("admin.categories.title_icon"),
    catTitleDrag: t("admin.categories.title_drag"),
    catTitleEdit: t("admin.categories.title_edit"),
    catConfirmDelete: t("admin.categories.cat_confirm_delete"),
    // tags
    tagDocTitle: t("admin.tags.doc_title"),
    tagBulkDelete: t("admin.tags.bulk_delete"),
    tagEmpty: t("admin.tags.empty"),
    tagEditTitle: t("admin.tags.edit_title"),
    tagPhName: t("admin.tags.ph_name"),
    tagPhSlug: t("admin.tags.ph_slug"),
    tagConfirmBulk: t("admin.tags.confirm_bulk"),
    tagTitleEdit: t("admin.tags.title_edit"),
    tagConfirmDelete: t("admin.tags.tag_confirm_delete"),
  };
  return { categories, tags, locale, s };
}

export async function adminUsers(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  requireSuperOnly(user);
  const out = await adminListUsers(user);
  // Same contract as every other admin screen (R485-R491).
  const locale = adminLocale(ctx);
  const t = makeT(locale);
  const s = {
    docTitle: t("admin.users.doc_title"),
    add: t("admin.users.add"),
    nickname: t("admin.users.nickname"),
    email: t("admin.users.email"),
    password: t("admin.users.password"),
    role: t("admin.users.role"),
    bio: t("admin.users.bio"),
    colUser: t("admin.users.col_user"),
    colRole: t("admin.users.col_role"),
    colCreated: t("admin.users.col_created"),
    colTwofa: t("admin.users.col_twofa"),
    twofaReset: t("admin.users.twofa_reset"),
    home: t("admin.users.home"),
    empty: t("admin.users.empty"),
    confirmDelete: t("admin.users.confirm_delete"),
    phName: t("admin.users.ph_name"),
    phPassword: t("admin.users.ph_password"),
    phBio: t("admin.users.ph_bio"),
    save: t("admin.common.save"),
    delete: t("admin.common.delete"),
    edit: t("admin.common.edit"),
    close: t("admin.common.close"),
    roles: {
      author: t("admin.roles.author"),
      authorHint: t("admin.roles.author_hint"),
      editor: t("admin.roles.editor"),
      editorHint: t("admin.roles.editor_hint"),
      admin: t("admin.roles.admin"),
      adminHint: t("admin.roles.admin_hint"),
      subscriber: t("admin.roles.subscriber"),
      subscriberHint: t("admin.roles.subscriber_hint"),
    },
  };
  // Every list loader hands the page `{ items, s }` (the dashboard, comments
  // and posts screens all do). Spreading the bare array here turned it into an
  // object with numeric keys, so the template's {#each} had no .map and the
  // whole page 500'd.
  return { items: out, locale, s };
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
    { value: "", label: adminLocale(ctx) === "en" ? "— none —" : "— 未选择 —" },
    ...pageOut.items.map((p) => ({ value: String(p.id), label: p.title })),
  ];
  // R496: the schema is written in Chinese (the source language). For an English
  // request every label / help / option label goes through SETTINGS_EN; an
  // untranslated string falls back to the Chinese rather than rendering a key,
  // so every new field must be added to SETTINGS_EN.
  const tt = makeT(adminLocale(ctx));
  const en = adminLocale(ctx) === "en" ? SETTINGS_EN : null;
  const tr = (text: string | undefined): string | undefined =>
    en && text ? (en[text] ?? text) : text;
  const schema = SITE_SETTINGS_SCHEMA.map((section) => ({
    ...section,
    label: tr(section.label) as string,
    ...(section.description ? { description: tr(section.description) as string } : {}),
    fields: section.fields.map((f) => ({
        ...f,
        label: tr(f.label) as string,
        ...(f.help ? { help: tr(f.help) } : {}),
        ...(f.placeholder ? { placeholder: tr(f.placeholder) as string } : {}),
        ...(f.options
          ? { options: f.options.map((o) => ({ ...o, label: tr(o.label) as string })) }
          : {}),
        ...(f.key === "activeThemeSlug"
          ? { options: themeOptions }
          : f.key === "homePageId" || f.key === "postsPageId"
            ? { options: pageOptions }
            : {}),
      })),
  }));
  const s = {
    docTitle: tt("admin.settings.doc_title"),
    title: tt("admin.settings.title"),
    lead: tt("admin.settings.lead"),
    save: tt("admin.settings.save"),
  };
  // homePageId / postsPageId are integers; select values are strings, so
  // normalise to string on the way out and back to number on save.
  const stored: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of ["homePageId", "postsPageId"]) {
    stored[k] = stored[k] == null ? "" : String(stored[k]);
  }
  // R551: the two options-store reads (feed_full_text, webhook_url) are
  // independent — one wave instead of two serial awaits on every settings
  // page load. Both have a short options cache, but a cold admin session
  // still paid two round trips here.
  const [feedFullText, webhookUrl] = await Promise.all([
    getOption<boolean>("feed_full_text", false),
    getOption<string>("webhook_url", ""),
  ]);
  // feed_full_text lives in the generic options store AND is mirrored by the
  // site_settings feedContent column (the save route keeps both in sync), so
  // the checkbox reflects the real feed behavior whichever end last saved.
  stored.feed_full_text = feedFullText === true || stored.feedContent === "full";
  // webhook_url lives in the generic options store (webhook.ts reads it from
  // there) — site_settings has no such column — so inject it for the form the
  // same way feed_full_text is injected above.
  stored.webhook_url = webhookUrl;
  return { settings: resolveSettings(schema, stored), schema, s };
}

export async function notFoundConfig(_p: unknown, ctx: Ctx) {
  const user = requireUser(ctx);
  if (user.role !== "admin") throw new ServiceError("权限不足", 403);
  const { getNotFoundSettings } = await import("./not-found-config.js");
  const settings = await getNotFoundSettings();
  const t = makeT(adminLocale(ctx));
  const s = {
    docTitle: t("admin.notfound.doc_title"),
    title: t("admin.notfound.title"),
    save: t("admin.notfound.save"),
    copyLabel: t("admin.notfound.copy_label"),
    colTitle: t("admin.notfound.col_title"),
    colBody: t("admin.notfound.col_body"),
    bodyHint: t("admin.notfound.body_hint"),
    modules: t("admin.notfound.modules"),
    showSearch: t("admin.notfound.show_search"),
    showSearchHint: t("admin.notfound.show_search_hint"),
    showRecent: t("admin.notfound.show_recent"),
    showRecentHint: t("admin.notfound.show_recent_hint"),
    defaultTitle: t("admin.notfound.default_title"),
    defaultMessage: t("admin.notfound.default_message"),
  };
  // The stored copy is the operator's content and stays as written; only the
  // form's own labels and the placeholders for an empty field are translated.
  return { ...settings, s };
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
    totalLabel: t("admin.page.total_label"),
    countUnit: t("admin.searchterms.count_unit"),
    pagePrefix: t("admin.page.page_prefix"),
    pageSuffix: t("admin.page.page_suffix"),
    localeZh: t("admin.searchterms.locale_zh"),
      title: t("searchterm.admin_title"),
      docTitle: t("searchterm.admin_doc_title"),
      prev: t("admin.common.prev"),
      next: t("admin.common.next"),
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
  const t = makeT(adminLocale(ctx));
  const wm = {
    docTitle: t("admin.webmentions.doc_title"),
    totalLabel: t("admin.page.total_label"),
    countUnit: t("admin.webmentions.count_unit"),
  };
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
      docTitle: t("admin.webmentions.doc_title"),
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
