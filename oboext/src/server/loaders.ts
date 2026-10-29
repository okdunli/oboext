// Isomorphic view-model layer.
import { contentEtag, ifNoneMatch } from "./etag.js";
import {
  archiveGroups,
  archiveItems,
  counts,
  getCategoryBySlug,
  getPostRow,
  hydrate,
  getSettings,
  getTagBySlug,
  getPublicAuthor,
  incrementViews,
  categoryPostCounts,
  listCategories,
  listCommentFeed,
  listPosts,
  listPostComments,
  listPostCommentsCached,
  listTags,
  popularPosts,
  randomPosts,
  relatedPosts,
  relatedByTaxonomy,
  getAdjacentPosts,
  searchSingleHit,
  type PostView,
  type PostRow,
  type TaxRef,
  MACHINE_WINDOW_CAP,
} from "./queries.js";
import { likedPostsFor, visitorKeyFromCookieHeader } from "./post-likes.js";
import { buildRobotsTxt } from "./sitemap.js";
import { dbStats, rawQuery } from "./db.js";
import { getPermalinkConfig, blogIndexUrlFor, pageIndexUrlFor, categoryUrlFor, tagUrlFor, authorUrlFor, AUTHOR_BASE_SEGMENT, resolveSitePath, paginate, postUrlFor, type PermalinkConfig } from "./links.js";
import { resolveVirtualRoute, type VirtualSiteRoute } from "./virtual-routes.js";
import { resolveCommentConfig } from "./comments-config.js";
import { registerView } from "./register-view.js";
import { getPublishedPageRow, hydrate as hydratePage, listPublishedPages } from "./pages.js";
import * as R from "./render.js";
import { adjacentHtml, adjacentKeyOf, adjacentRelLinks } from "./adjacent.js";
import * as admin from "./admin-loaders.js";
import { getMenuByLocation, localizeMenu } from "./menus.js";
import { pageNum } from "./paging.js";
import { getAreaWidgets } from "./widgets.js";
import { getActiveThemeSlug, getActiveThemeRenderConfig, getActiveThemeSettings, getThemeManifest } from "./themes.js";
import { themeToCss, resolveThemeConfig } from "./theme-tokens.js";
import { skyscraperBridgeRoot, skyscraperBridgeDark, themeColorMetas } from "./theme-bridge.js";
import { HOOKS, applyFilters } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { getNotFoundSettings } from "./not-found-config.js";
import { redirectFor as ruleFor } from "./redirects.js";
import { memoQuery, peekMemo, kvGet, kvSet } from "./cache.js";
import { getPublicRegisterConfig } from "./members.js";
import { maintenanceGate, type MaintenanceSettings } from "./maintenance.js";
import { renderUserCenter, renderUserCenterGuest } from "./account.js";
import { loginCardHtml, secretEntryPageHtml } from "./login-card.js";
import { getAdminSecurity } from "./security.js";
import { can } from "./admin.js";
import { recordSearchTerm } from "./search-terms.js";
import { getThemeChrome, publicAssetHref, themeScriptTags, themeLayout, catIconName, type MenuItem } from "./theme-chrome.js";
import { dialectProfile, blogListSize, categoryListSize, tagListSize } from "./dialects.js";
import { createLogger } from "./logger.js";
import {
  DEFAULT_LOCALE,
  makeT,
  htmlLangOf,
  hreflangLinks,
  isPairingActive,
  localeHref,
  canonicalPath,
  otherLocale,
  prefixLocaleUrls,
  setPairingActive,
  splitLocalePath,
  type Locale,
  type Translate,
} from "./i18n.js";
const log = createLogger("loaders");

/** The request locale, defaulting when the middleware did not set one. */
function localeOf(ctx?: Ctx): Locale {
  const raw = ctx && ctx.locale;
  return raw === "en" || raw === "zh-CN" ? raw : DEFAULT_LOCALE;
}

export type Ctx = {
  query: URLSearchParams;
  origin: string;
  pathname: string;
  ip: string;
  ua: string;
  /** Raw `Referer` header of this request (0041 traffic sources). "" when absent. */
  referer?: string;
  user?: unknown;
  /** Request locale, set by the middleware from the /en path prefix. */
  locale?: string;
  /** Raw `cookie` header of this request ("" when absent). The post-likes
   *  backfill reads visitor_key off it; minting the cookie is the API's job. */
  cookie?: string;
};

/** This request's visitor identity, or null when it carries no visitor_key
 *  yet — a brand-new visitor has nothing to backfill, so no query is issued. */
function visitorKeyOf(ctx?: Ctx): string | null {
  return visitorKeyFromCookieHeader(ctx?.cookie);
}

/** The one batched read a list page runs for this visitor's like state. Issued
 *  BEFORE the return so the window's items and the payload's `likedIds` share
 *  the SAME round trip (one query per page, never N+1). No visitor_key yet ->
 *  an empty set, no query at all. */
function likedPFor(ctx: Ctx | undefined, items: { id: number }[]): Promise<Set<number>> {
  return likedPostsFor(visitorKeyOf(ctx), items.map((i) => i.id));
}

/** Attach each item's `liked` flag once that read has resolved (pure). */
function markLiked<T extends { id: number }>(
  items: T[],
  liked: Set<number>,
): (T & { liked: boolean })[] {
  return items.map((i) => ({ ...i, liked: liked.has(i.id) }));
}

// ------------------------------------------------------------- plugin hooks

export type HeadContext = {
  kind: "home" | "post" | "page" | "archive" | "taxonomy" | "search";
  siteTitle: string;
  siteUrl: string;
  title?: string;
  description?: string;
  image?: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  author?: string;
  url?: string;
  breadcrumbs?: { label: string; href: string }[];
};

async function pluginFooterHtml(kind: string): Promise<string> {
  await ensurePluginsLoaded();
  const payload = applyFilters<{ html: string[]; kind: string }>(HOOKS.footerHtml, {
    html: [],
    kind,
  });
  const joined = payload.html.join("\n");
  if (!joined) return "";
  return `<div id="oboe-footer-hooks" aria-hidden="true" style="display:none">${joined}</div>`;
}

/**
 * The subscribe door, on every public page's footer (site discoverability).
 *
 * Placed INSIDE the theme's own <footer> — just before its closing tag —
 * rather than as a `footerMenu` item, because only the default theme renders
 * footerMenu (skyscraper's R.footerHtml ignores it, and so do bluemix/codeman/
 * pseudolinear), and appending after tc.footer()'s whole string would park the
 * link outside <footer> on every theme. Every one of the five chrome modules
 * emits exactly one `</footer>`, so the splice is well defined; a future theme
 * that does not falls back to a plain append, which still keeps the link
 * visible.
 *
 * The styling is inline and token-driven rather than a theme class: the five
 * themes share no footer-link class (bmx `footer a`, codeman `.cm-footer a`,
 * skyscraper `footer .links a`, ...), and a bare anchor reads as an
 * accident. The pill reuses --accent/--accent-text — the very tokens the
 * appearance panel writes — so it follows the site's palette on every theme
 * and both colour schemes, and it costs no stylesheet edit (the red line on
 * this round is that `oboext/public/` and `themes/*` stay untouched).
 *
 * The href stays root-relative on purpose: chrome() runs the whole footer
 * through prefixLocaleUrls(), so an /en reader gets /en/newsletter for free
 * and the default locale keeps byte-identical output.
 */
function withNewsletterFooter(html: string, t: Translate): string {
  if (!html) return html;
  const link =
    `<div data-newsletter-cta style="margin:1.25rem 0 .25rem;text-align:center">` +
    `<a href="/newsletter" data-newsletter-link style="display:inline-flex;align-items:center;gap:.4rem;` +
    `padding:.5rem 1.1rem;border-radius:999px;border:1px solid var(--border, rgba(127,127,127,.35));` +
    `background:var(--surface, transparent);color:var(--accent, inherit);font-size:.8125rem;font-weight:600;` +
    `line-height:1.2;text-decoration:none">` +
    `${R.esc(t("newsletter.footer_link"))}</a></div>`;
  const closeAt = html.lastIndexOf("</footer>");
  if (closeAt < 0) return html + link;
  return html.slice(0, closeAt) + link + html.slice(closeAt);
}

function verificationMetaHtml(raw: unknown): string {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const val = v[k];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    return "";
  };
  const out: string[] = [];
  const google = pick("google", "google-site-verification");
  const yandex = pick("yandex", "yandex-verification");
  const bing = pick("bing", "msvalidate.01");
  const yahoo = pick("yahoo", "y_key");
  if (google) out.push(`<meta name="google-site-verification" content="${R.esc(google)}">`);
  if (yandex) out.push(`<meta name="yandex-verification" content="${R.esc(yandex)}">`);
  if (bing) out.push(`<meta name="msvalidate.01" content="${R.esc(bing)}">`);
  if (yahoo) out.push(`<meta name="y_key" content="${R.esc(yahoo)}">`);
  return out.join("\n");
}

/**
 * twitter:site meta for the stored X/Twitter handle. The value is a public
 * handle, so it is escaped and length-capped; "@" is accepted with or without
 * the leading "@" and normalised to the form X expects.
 */
function twitterSiteMetaHtml(raw: unknown): string {
  const h = typeof raw === "string" ? raw.trim() : "";
  if (!h || !/^@?[A-Za-z0-9_]{1,15}$/.test(h)) return "";
  return `<meta name="twitter:site" content="${R.esc(h.startsWith("@") ? h : `@${h}`)}">`;
}

/**
 * The description a post/page falls back to when it has none of its own.
 * R225: the SEO panel's "默认描述" is that fallback - it was stored and never
 * read, so a content-free post borrowed the site tagline instead.
 */
function defaultDescription(settings: { siteDescription?: string | null; seoDefaultDescription?: string | null }): string {
  return settings.seoDefaultDescription || settings.siteDescription || "";
}

/**
 * Google Analytics tag for the stored measurement id. The id charset is
 * restricted so it cannot break out of the attribute or the JSON string.
 */
function analyticsSnippet(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return "";
  return (
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
    `gtag('js',new Date());gtag('config',${JSON.stringify(id)});</script>`
  );
}

/** Collect plugin <head> nodes for a page (head.tags filter). */
async function pluginHeadHtml(context: HeadContext): Promise<string> {
  await ensurePluginsLoaded();
  const payload = applyFilters<{ nodes: string[]; context: HeadContext }>(
    HOOKS.headTags,
    { nodes: [], context },
  );
  return payload.nodes.join("\n");
}

/**
 * Generic head context for pages whose loader does not build its own:
 * home, the blog index, search and archives. Entity pages (post, page,
 * category, tag) carry richer facts and build theirs in their own loaders.
 * The blog index URL is config-driven (permalink prefixes can be renamed).
 */
function chromeHeadContext(
  pathname: string,
  siteTitle: string,
  origin: string,
  blogIndex: string,
  t: Translate,
): HeadContext {
  if (pathname === "/") return { kind: "home", siteTitle, siteUrl: origin };
  if (pathname === blogIndex || pathname === blogIndex + "/")
    return {
      kind: "archive",
      siteTitle,
      siteUrl: origin,
      title: t("head.all_posts"),
      breadcrumbs: [
        { label: t("crumb.home"), href: "/" },
        { label: t("crumb.posts"), href: blogIndex },
      ],
    };
  if (pathname.indexOf("/search") === 0)
    return { kind: "search", siteTitle, siteUrl: origin, title: t("search.title") };
  return { kind: "archive", siteTitle, siteUrl: origin };
}

/**
 * Entity/taxonomy detail pages build head nodes in their own loader (with
 * the entity's title/dates/breadcrumbs), so the chrome-level pass skips
 * them to avoid double emission. The prefixes come from the permalink
 * config, so a renamed prefix still skips exactly the entity pages.
 */
function chromeSkipsHead(pathname: string, cfg: PermalinkConfig): boolean {
  const bases = [cfg.postBase, cfg.pageBase, cfg.categoryBase, cfg.tagBase]
    .map((b) => ("/" + b).replace(/\/+$/, ""))
    .filter((b) => b !== "");
  return bases.some((b) => pathname.indexOf(b + "/") === 0);
}

function chromePageKind(pathname: string, cfg: PermalinkConfig): string {
  if (pathname === "/") return "home";
  if (pathname.indexOf("/search") === 0) return "search";
  const base = (b: string) => ("/" + b).replace(/\/+$/, "") + "/";
  if (cfg.postBase && pathname.indexOf(base(cfg.postBase)) === 0) return "post";
  if (cfg.pageBase && pathname.indexOf(base(cfg.pageBase)) === 0) return "page";
  if (cfg.categoryBase && pathname.indexOf(base(cfg.categoryBase)) === 0) return "taxonomy";
  if (cfg.tagBase && pathname.indexOf(base(cfg.tagBase)) === 0) return "taxonomy";
  return "archive";
}

// ------------------------------------------------------------------- chrome

// Built-in sidebar used until an admin defines a "sidebar" menu; mirrors
// SKY_SIDEBAR_FALLBACK in themes/skyscraper/Layout.tsx, with the index URL
// driven by the permalink config so a renamed prefix rewires it too.
const sidebarFallback = (cfg: PermalinkConfig, t: Translate): R.SkyItem[] => [
  { id: "s1", label: t("sidebar.home"), url: "/" },
  { id: "s2", label: t("sidebar.all_posts"), url: blogIndexUrlFor(cfg) },
  // R178: the page directory is only linkable when it has a URL — a disabled
  // page base leaves pageIndexUrlFor empty and the pages stay root slugs.
  ...(pageIndexUrlFor(cfg)
    ? [{ id: "s3", label: t("sidebar.all_pages"), url: pageIndexUrlFor(cfg) }]
    : []),
];

// Menu label policy lives in menus.ts (localizeMenu); only the defaults the
// program itself seeded are translated, admin-typed labels stay literal.

// Plain trusted-string chrome pieces. chrome() hands them to the .rose
// templates (emitted via {@html}); the 404 route rides the same chrome
// through the framework's normal render pipeline.
async function chromeData(pathname: string, t: Translate) {
  // The two widget-area reads gate on the theme slug; chaining them off a
  // pre-issued themeSlug promise folds the old second wave into the opening
  // one. They used to issue only after every read below had resolved - a
  // full extra RTT whenever the 30s sidebar memos had expired.
  const themeSlugP = safe(getActiveThemeSlug());
  const widgetsP = safe(
    themeSlugP.then((s) =>
      Promise.all([getAreaWidgets(s, "sidebar"), getAreaWidgets(s, "footer")]),
    ),
  );
  const [
    settings,
    tagRows,
    stats,
    popular,
    cfg,
    sideMenu,
    themeSlug,
    renderConfig,
    themeSettings,
    headerMenu,
    footerMenu,
  ] = await Promise.all([
    getSettings(),
    listTags(),
    counts(),
    popularPosts(5),
    getPermalinkConfig(),
    getMenuByLocation("sidebar"),
    themeSlugP,
    getActiveThemeRenderConfig(),
    getActiveThemeSettings(),
    getMenuByLocation("header"),
    getMenuByLocation("footer"),
  ]);
  const [sideWidgets, footerWidgets] = await widgetsP;
  // Active-theme design tokens, emitted after /public/theme.css so saved
  // overrides win. customCss is admin-authored and follows on purpose.
  // Public paths only — admin keeps its own admin.css design.
  //
  // FRAMEWORK LIMITATION (rosezm 0.2.3, reported in rosezm/BUG.md):
  // <head> blocks merge ONLY title/meta/link/base — mergeHeadBlocks
  // (shell.ts) regexes those tags and the client applyHead() requires a
  // name/property/rel/charset attribute — so a <style> in <head> is silently
  // dropped on both server and client. The :root variables ride the proven
  // body raw-HTML channel at the top of <body> instead; a :root selector
  // applies identically from a body-positioned stylesheet (HTML5 allows
  // <style> in body), so the visual result is pixel-identical.
  // Skyscraper's stylesheet consumes its private --sk-* scale; derive it
  // from the saved generic tokens so the appearance panel actually repaints
  // (light + dark blocks). See theme-bridge.ts.
  const themeManifest = getThemeManifest(themeSlug);
  const skBase = (themeManifest?.config ?? {}) as Parameters<
    typeof skyscraperBridgeRoot
  >[1];
  // Private token-scale bridge: the theme declares it (manifest
  // "tokensBridge"), the program does not know the theme's name.
  const skBridge =
    themeManifest?.tokensBridge === "skyscraper"
      ? {
          root: skyscraperBridgeRoot(renderConfig, skBase),
          dark: skyscraperBridgeDark(renderConfig, skBase),
        }
      : { root: "", dark: "" };
  const varsHtml =
    pathname.indexOf("/admin") === 0
      ? ""
      : `<style id="rv-theme-vars">:root{${themeToCss(renderConfig)}${skBridge.root ? ";" + skBridge.root : ""}}` +
        (skBridge.dark ? `[data-color-scheme="dark"]{${skBridge.dark}}` : "") +
        `</style>` +
        (typeof renderConfig.customCss === "string" && renderConfig.customCss
          ? `<style id="rv-theme-custom">${renderConfig.customCss}</style>`
          : "");
  const tags = tagRows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) }));
  const menuItems: R.SkyItem[] =
    sideMenu && sideMenu.items.length
      ? localizeMenu(sideMenu.items as R.SkyItem[], t)
      : sidebarFallback(cfg, t);
  const tc = getThemeChrome(themeSlug);
  // Theme JS, mtime-stamped. Built here (not as `{chrome().x}` attributes in
  // the .rose layout) because the template compiler only interpolates
  // attributes it can resolve statically — a raw-HTML channel is the proven
  // path (same as bodyFix/nav/bodyOpen).
  //
  // The theme's own scripts come from its manifest ("scripts" → the theme's
  // assets/ dir, "publicScripts" → program-owned /public/ assets), so the
  // program carries no per-theme script list. The program-level runtime
  // (csrf/reading-mode/comments) brackets them.
  const themeScripts =
    `<script src="${publicAssetHref("csrf.js")}" defer></script>` +
    themeScriptTags(themeSlug) +
    `<script src="${publicAssetHref("reading-mode.js")}" defer></script>` +
    `<script src="${publicAssetHref("comments.js")}" defer></script>`;
  const headerItems: MenuItem[] = localizeMenu((headerMenu?.items ?? []) as MenuItem[], t);

  const footerHtml = withNewsletterFooter(
    tc.footer(
      {
        ...settings,
        t,
        footerContainerAlign: (themeSettings as Record<string, unknown>).footerContainerAlign,
        footerMenu: localizeMenu((footerMenu?.items ?? []) as MenuItem[], t),
      },
      R.widgetAreaHtml(footerWidgets, "sk-footer-widgets", t),
    ),
    t,
  );

  // renders customCss + customHead at body open and customFooter + the
  // analytics tag at body end, so the same markup order is kept here. Both
  // ride raw-HTML channels: <style>/<script> in <head> are dropped by the
  // framework's head merge, body-positioned ones are not.
  const customCss = typeof settings.customCss === "string" ? settings.customCss.trim() : "";
  const customHead = typeof settings.customHead === "string" ? settings.customHead.trim() : "";
  const customFooter =
    typeof settings.customFooter === "string" ? settings.customFooter.trim() : "";
  const siteBodyOpen =
    (customCss ? `<style id="oboe-custom-css">${customCss}</style>` : "") + customHead;
  const siteBodyEnd = [customFooter, analyticsSnippet(settings.analyticsId)]
    .filter(Boolean)
    .join("\n");
  return {
    siteTitle: settings.siteTitle ?? "",
    siteDescription: settings.siteDescription ?? "",
    logoUrl: settings.logoUrl ?? "",
    ogImageUrl: settings.ogImageUrl ?? "",
    twitterCard: settings.twitterCard ?? "",
    seoRobots: settings.seoRobots ?? "",
    varsHtml,
    siteHead: verificationMetaHtml(settings.verifications),
    // R223: the site's X/Twitter handle. Stored in settings for three rounds
    // and never rendered anywhere, so every card went out unattributed.
    twitterSiteHtml: twitterSiteMetaHtml(settings.twitterSite),
    themeColorHtml: themeColorMetas(renderConfig.background),
    siteBodyOpen,
    siteBodyEnd,
    themeSlug,
    layout: themeManifest?.layout || "default",
    cssHref: tc.cssHref(),
    // The inlined copy of the same stylesheet. Optional on the interface: a
    // theme that does not implement cssInline() yields "", and the layout then
    // emits only the <link>. Called through the same tc the rest of the chrome
    // comes from, so the two cannot drift onto different themes.
    cssInline: tc.cssInline ? tc.cssInline() : "",
    themeScripts,
    bodyFix: tc.bodyFix() + siteBodyOpen,
    headExtra: tc.headExtra(),
    navHtml: tc.nav({ ...settings, __pathname: pathname, t }, headerItems),
    bodyOpen: tc.bodyOpen({ ...settings, __pathname: pathname, t }, headerItems),
    bodyClose: tc.bodyClose(
      { ...settings, t, analyticsCode: (themeSettings as Record<string, unknown>).analyticsCode },
      footerHtml,
    ),
    asideHtml: tc.aside({
      menu: R.sidebarMenu(menuItems, pathname),
      tagCloud: R.tagCloud(tags, t),
      stats: R.blogStats(stats, t),
      popular: R.popularWidget(popular, t),
      widgets: R.widgetAreaHtml(sideWidgets, "sk-widget-area", t),
    }),
    footerHtml,
  };
}

async function chrome(_payload: unknown, ctx?: Ctx) {
  const pathname = (ctx && ctx.pathname) || "/";
  const origin = (ctx && ctx.origin) || "";
  const locale = localeOf(ctx);
  const t = makeT(locale);
  const statsOn = process.env.OBOEXT_DB_STATS === "1";
  const t0 = statsOn ? Date.now() : 0;
  const before = statsOn ? dbStats() : null;
  const [d, cfg] = await Promise.all([chromeData(pathname, t), getPermalinkConfig()]);
  const isAdmin = pathname.indexOf("/admin") === 0;
  const blogIndex = blogIndexUrlFor(cfg);
  // Independent reads: fetch them together instead of two serial awaits.
  const [pluginFooterRaw, pluginHead] = await Promise.all([
    isAdmin ? "" : pluginFooterHtml(chromePageKind(pathname, cfg)),
    isAdmin || chromeSkipsHead(pathname, cfg)
      ? ""
      : pluginHeadHtml(chromeHeadContext(pathname, d.siteTitle, origin, blogIndex, t)),
  ]);
  const pluginFooter = isAdmin ? "" : pluginFooterRaw + d.siteBodyEnd;
  if (statsOn) {
    const s = dbStats();
    const ms = Date.now() - t0;
    log.info(
      `[stats] chrome(${pathname}) queries=${s.count - (before?.count ?? 0)} ` +
        `dbTime=${s.total - (before?.total ?? 0)}ms wall=${ms}ms`,
    );
  }
  // Under a non-default locale every root-relative link in the chrome keeps
  // the visitor inside the locale. The default locale short-circuits, so the
  // zh-CN output is byte-identical to before i18n existed.
  const pre = (html: string) => prefixLocaleUrls(html, locale);
  // The locale switcher. data-no-pjax forces a full document load: pjax only
  // swaps #sk-main, so a soft navigation would leave the rest of the chrome
  // (nav, footer) in the old language. pjax.js keeps the href in sync
  // with location.pathname on rv:nav, so the pill never goes stale.
  // R275: when THIS document is one half of a translation pair, the switcher
  // lands on the OTHER HALF of the pair (a reader reading the zh post gets
  // the en twin of the same article) instead of the other locale's index.
  // The pair travels through a request-scoped global: chrome() runs in a
  // different loader dispatch than resolve() and there is no shared view here.
  const pairUrl = (ctx as { pairSwitchTarget?: string } | undefined)?.pairSwitchTarget;
  const switchTarget = pairUrl ?? localeHref(pathname, otherLocale(locale));
  const localeSwitch = isAdmin
    ? ""
    : `<a data-locale-switch data-no-pjax href="${R.esc(switchTarget)}" ` +
      `style="position:fixed;right:14px;bottom:14px;z-index:2147483000;display:inline-flex;align-items:center;` +
      `gap:6px;padding:7px 13px;border-radius:999px;border:1px solid var(--border,#d4d4d8);` +
      `background:var(--surface,#ffffff);color:var(--text,#18181b);font-size:13px;line-height:1;` +
      `text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.14)">${t("locale.switch")}</a>`;
  return {
    siteTitle: d.siteTitle,
    siteDescription: d.siteDescription,

    siteUrl: origin,
    siteHead: isAdmin ? "" : d.siteHead,
    twitterSiteHtml: isAdmin ? "" : d.twitterSiteHtml,
    themeColorHtml: d.themeColorHtml,
    // Site-level social card: the logo when one is set (absolute), the meta
    // set built from it, and "" for both when it is not.
    ogImage: R.socialImage(d.logoUrl, origin, d.ogImageUrl),
    // R225: the robots / card kind the layout renders, so the panel's choices
    // are honoured on the routes whose head comes from the layout, not a loader.
    robots: R.robotsFor(d.seoRobots),
    twitterCard: R.twitterCardKind(d.twitterCard, R.socialImage(d.logoUrl, origin, d.ogImageUrl)),
    ogImageHtml: isAdmin ? "" : R.socialImageMetas(d.logoUrl, origin, d.siteTitle),
    themeHead: d.varsHtml + d.headExtra,
    themeSlug: d.themeSlug,
    layout: d.layout,
    cssHref: d.cssHref,
    cssInline: d.cssInline,
    themeScripts: d.themeScripts,
    bodyFix: d.bodyFix + localeSwitch,
    nav: pre(d.navHtml),
    bodyOpen: pre(d.bodyOpen),
    bodyClose: pre(d.bodyClose),
    aside: pre(d.asideHtml),
    footer: pre(d.footerHtml),
    htmlLang: htmlLangOf(locale),
    locale,
    pluginFooter,
    pluginHead,
  };
}

// --------------------------------------------------------------------- home

// -------- bluemix home helpers (mirror themes/bluemix/HomePage.tsx logic) --------

async function sideWidgetsFor(themeSlug: string, t?: Translate): Promise<string> {
  const layout = themeLayout(themeSlug);

  if (layout !== "codeman" && layout !== "pseudolinear") return "";
  const wrap = layout === "pseudolinear" ? "pl-side-stack" : "sk-widget-area";
  return R.widgetAreaHtml(await getAreaWidgets(themeSlug, "sidebar"), wrap, t);
}

// Sync twin of sideWidgetsFor: identical markup, but over an area that was
// already read, so a post view does not issue the sidebar query twice.
function sideWidgetsHtml(
  themeSlug: string,
  items: Awaited<ReturnType<typeof getAreaWidgets>>,
  t?: Translate,
): string {
  const layout = themeLayout(themeSlug);
  if (layout !== "codeman" && layout !== "pseudolinear") return "";
  const wrap = layout === "pseudolinear" ? "pl-side-stack" : "sk-widget-area";
  return R.widgetAreaHtml(items, wrap, t);
}

async function bmixDrawerPosts(themeSlug: string): Promise<PostView[] | undefined> {
  const layout = themeLayout(themeSlug);
  if (layout !== "bluemix") return undefined;
  // Sidebar reads run on every page: memoize 60s. A content write drops the
  // entry (kvSet registers the key), so a new post shows up immediately.
  const key = "sidebar:drawer";
  const hit = kvGet<PostView[]>(key);
  if (hit) return hit;
  const { items } = await listPosts({ status: "published", limit: 8 });
  kvSet(key, items, 60);
  return items;
}

async function defaultSidebarData(want: boolean, showCatIcons = false): Promise<{ posts: PostView[]; tags: TaxRef[]; cats: TaxRef[]; showCatIcons: boolean; catCounts: Map<number, number> } | undefined> {
  if (!want) return undefined;
  const sKey = `sidebar:default:${showCatIcons}`;
  const sHit = kvGet<{ items: PostView[]; tagRows: TaxRef[]; catRows: TaxRef[]; cfg: any; catCounts: Map<number, number> }>(sKey);
  if (sHit) {
    const { items, tagRows, catRows, cfg, catCounts } = sHit;
    return {
      posts: items,
      tags: tagRows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) })),
      cats: catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) })),
      showCatIcons,
      catCounts: catCounts ?? new Map<number, number>(),
    };
  }
  // The counts ride the same Promise.all as the rows: one more scalar query
  // next to the taxonomy reads, rather than a round trip per category.
  const [{ items }, tagRows, catRows, cfg, catCounts] = await Promise.all([
    listPosts({ status: "published", limit: 5 }),
    listTags(),
    listCategories(),
    getPermalinkConfig(),
    categoryPostCounts(),
  ]);
  kvSet(sKey, { items, tagRows, catRows, cfg, catCounts }, 60);
  return {
    posts: items,
    tags: tagRows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) })),
    cats: catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) })),
    showCatIcons,
    catCounts,
  };
}

function bmClamp(v: unknown, dft: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function bmStrOr(v: unknown, dft: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s || dft;
}
const BM_RANK_KEYS = ["most_comments", "most_likes", "most_reads"] as const;
type BmRankKey = (typeof BM_RANK_KEYS)[number];
function bmRankOrderFrom(v: unknown): BmRankKey[] {
  const SHORT: Record<string, BmRankKey> = { comments: "most_comments", likes: "most_likes", reads: "most_reads" };
  const parsed = String(v ?? "").split(",").map((s) => SHORT[s.trim()]).filter((k): k is BmRankKey => !!k);
  const order = Array.from(new Set(parsed));
  for (const k of BM_RANK_KEYS) if (!order.includes(k)) order.push(k);
  return order;
}
function bmRankDefaultFrom(v: unknown, fallback: BmRankKey): BmRankKey {
  const key = `most_${String(v ?? "").trim()}`;
  return (BM_RANK_KEYS as readonly string[]).includes(key) ? (key as BmRankKey) : fallback;
}
function bmToRankPost(p: any): { id: number; url: string; title: string; thumbnail: string | null; likes: number; comments: number; views: number } {
  return {
    id: p.id,
    url: p.url,
    title: p.title,
    thumbnail: p.featuredImage ?? null,
    likes: p.likes ?? 0,
    comments: p.commentsCount ?? 0,
    views: p.views ?? 0,
  };
}

type HomeBundle = {
  all: Awaited<ReturnType<typeof listPosts>>;
  popular: Awaited<ReturnType<typeof listPosts>>;
  catRows: Awaited<ReturnType<typeof listCategories>>;
  random: Awaited<ReturnType<typeof randomPosts>>;
};

async function home(ctx?: Ctx) {
  const locale = localeOf(ctx);
  const t = makeT(locale);
  // Newsletter landing notice: the endpoints 302 back to the home URL with
  // ?subscribed=1 / ?unsubscribed=1 / ?newsletter_error=1 (the failure leg
  // already has its own param), and the page otherwise renders nothing. Home
  // turns the param into a notice the catch-all prints as the first thing in
  // the content area; no param -> kind null, so a plain home visit shows none.
  const noticeKind =
    ctx?.query?.get("subscribed") === "1"
      ? "subscribed"
      : ctx?.query?.get("unsubscribed") === "1"
        ? "unsubscribed"
        : ctx?.query?.get("newsletter_error") === "1"
          ? "error"
          : null;
  const notice = {
    kind: noticeKind,
    text: noticeKind
      ? t(
          noticeKind === "subscribed"
            ? "newsletter.subscribed"
            : noticeKind === "unsubscribed"
              ? "newsletter.unsubscribed"
              : "newsletter.invalid_token",
        )
      : "",
  };
  // Everything home reads is independent of everything else it reads: the old
  // shape gated three waves behind each other (settings/themeSlug first, the
  // list queries second, the sidebar batch third), so a cold home paid ~3
  // Neon RTTs on top of each list's own hydration. One Promise.all now issues
  // every main query at once; only the lists' hydration (it needs the post
  // ids first) still forms a second wave. homeLimit was the one real
  // coupling - resolved by always fetching the pseudolinear maximum (30) and
  // slicing per theme below. Reads that used to be gated on themeSlug (theme
  // settings, per-category counts) run unconditionally: they ride the same
  // wave, so an unused read costs server work but no wall time.
  // The bundle (lists + categories + shuffle pool) is theme-independent and
  // memoized through the framework KV primitive for 60s - a shuffle that
  // changes once a minute is still a shuffle to any visitor.
  const cachedHome = kvGet<HomeBundle>("home:bundle");
  // Widget area chains off the themeSlug read: the re-read rides the opening
  // wave, and for themes that render sidebar widgets (codeman, pseudolinear)
  // the area query issues mid-wave instead of after it. Returns "" without
  // querying for the other themes (default, skyscraper, bluemix).
  const widgetsP = getActiveThemeSlug().then(sideWidgetsFor);
  const [settings, themeSlug, cfg, tagRows, ts, catCounts, all, popular, catRows, random] =
    await Promise.all([
      getSettings(),
      getActiveThemeSlug(),
      getPermalinkConfig(),
      listTags(),
      getActiveThemeSettings(),
      categoryPostCounts(),
      cachedHome ? Promise.resolve(cachedHome.all) : listPosts({ status: "published", limit: 30 }),
      cachedHome
        ? Promise.resolve(cachedHome.popular)
        : listPosts({ status: "published", limit: 4, orderBy: "views" }),
      cachedHome ? Promise.resolve(cachedHome.catRows) : listCategories(),
      cachedHome ? Promise.resolve(cachedHome.random) : randomPosts(20),
    ]);
  // The chrome LAYOUT dialect this theme declares (see theme-api).
  const layout = themeLayout(themeSlug);
  if (!cachedHome) kvSet("home:bundle", { all, popular, catRows, random }, 60);
  const homeLimit = dialectProfile(layout).homeLimit;
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const items = all.items.slice(0, homeLimit);
  const tc = getThemeChrome(themeSlug);

  // non-bluemix themes render from the slim hero/latest split; skip the extra
  // queries so their home stays cheap.
  // mirror buildEntityMetadata(kind:"home")：canonical = origin。
  // WebSite JSON-LD rides the home head: SearchAction is only truthful here
  // (the /search route is the sitewide query target).
  const origin0 = ctx?.origin ?? "";
  const homeCanonical = `${origin0}${canonicalPath("/", locale)}`;
  const siteName = settings.siteTitle ?? "";
  // og:image must be absolute (the OG spec: scrapers silently drop a relative
  // path). Prefix the site origin when logoUrl is a root-relative upload.
  const homeOgImage = R.esc(R.socialImage(settings.logoUrl, origin0, settings.ogImageUrl));
  const homeHead =
    `<link rel="canonical" href="${R.esc(homeCanonical)}">` +
    `<meta property="og:site_name" content="${R.esc(siteName)}">` +
    `<meta property="og:image" content="${homeOgImage}">` +
    `<meta name="twitter:image" content="${homeOgImage}">` +
    `<meta name="twitter:card" content="${R.twitterCardKind(settings.twitterCard, homeOgImage)}">` +
    R.jsonLd({
      "@context": "https://schema.org",
      "@type": "WebSite",
      // Same @id the seo-schema plugin's node uses: two WebSite nodes on one
      // page merge into one entity instead of competing.
      "@id": `${origin0}/#website`,
      name: siteName,
      description: settings.siteDescription ?? "",
      url: homeCanonical,
      inLanguage: locale,
      potentialAction: {
        "@type": "SearchAction",
        // Build from localeHref("/search", locale), NOT homeCanonical: for /en
        // that is "/en/search", whereas homeCanonical ("/en") + "search"
        // concatenates into the broken "/ensearch?q=". Navigation (where the
        // /en user's query lands) rides localeHref; the document's IDENTITY
        // (canonical) merged to the bare path in R269.
        target: `${origin0}${localeHref("/search", locale)}?q={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    });
  if (layout !== "bluemix") {
    // tagRows/ts/catCounts ride the opening wave (see above); widgetsP was
    // issued alongside it.
    const widgets = await widgetsP;
    const tags = tagRows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) }));
    const dp = dialectProfile(layout);
    return {
      head: homeHead,
      main: tc.home({

        hero: dp.heroCount === 0 ? items : items.slice(0, dp.heroCount),
        latest: dp.heroCount === 0 ? [] : items.slice(dp.heroCount, dp.heroCount + dp.latestCount),
        liked: popular.items,
        random,
        cats,
        tags,
        catCounts,
        total: all.total,
        widgets,
        settings: { ...settings, t },
        themeSettings: ts,
      }),
      notice,
    };
  }

  // ---- bluemix full two-column home (banner + sidebar + catnav + rankings + sections) ----
  // `ts` rides the opening wave (see top of home()); the rest of the branch
  // below depends on it only through pure-JS row building.
  const blogIndex = blogIndexUrlFor(cfg);
  const showHero = ts.showHero !== false;
  const recentCount = bmClamp(ts.homeRecentCount, 8, 1, 24);
  const catCount = bmClamp(ts.homeCategoryCount, 5, 1, 10);
  const bannerMax = bmClamp(ts.bannerMaxCount, 5, 1, 10);
  const mode = ts.homeCategoryMode === "custom" || ts.homeCategoryMode === "off" ? (ts.homeCategoryMode as string) : "auto";
  const rows: { category: any; title: string; icon: string | null }[] = [];
  if (mode === "auto") {
    for (const c of cats) rows.push({ category: c, title: c.name, icon: (c as any).icon ?? null });
  } else if (mode === "custom" && Array.isArray(ts.homeCategories)) {
    const seen = new Set<string>();
    for (const r of ts.homeCategories as { slug?: string; title?: string; icon?: string | null }[]) {
      const slug = String(r?.slug ?? "");
      if (!slug || seen.has(slug)) continue;
      const category = cats.find((c) => c.slug === slug);
      if (!category) continue;
      seen.add(slug);
      rows.push({ category, title: String(r?.title ?? "").trim() || category.name, icon: typeof r?.icon === "string" && r.icon.trim() ? r.icon.trim() : null });
    }
  }
  // recent, the per-category sections, the three ranking lists and the two
  // widget areas are mutually independent once `ts` is known - one wave
  // instead of three (each used to be a full Neon RTT on a cold home).
  const showRankings = ts.showRankings !== false;
  type RankList = Awaited<ReturnType<typeof listPosts>>;
  // Array destructuring cannot place a rest element mid-pattern, so the
  // combined wave is sliced by index (rows.length is dynamic).
  const results = await Promise.all([
    listPosts({ status: "published", limit: Math.max(recentCount, bannerMax, 8) }),
    ...rows.map((r) => listPosts({ status: "published", categorySlug: r.category.slug, limit: catCount })),
    showRankings ? listPosts({ status: "published", orderBy: "comments", limit: 3, pinned: false }) : Promise.resolve(undefined),
    showRankings ? listPosts({ status: "published", orderBy: "likes", limit: 3, pinned: false }) : Promise.resolve(undefined),
    showRankings ? listPosts({ status: "published", orderBy: "views", limit: 3, pinned: false }) : Promise.resolve(undefined),
    getAreaWidgets(themeSlug, "home-top"),
    getAreaWidgets(themeSlug, "sidebar"),
  ]) as unknown[];
  const recent = results[0] as RankList;
  const sectionLists = results.slice(1, 1 + rows.length) as RankList[];
  const rc = results[1 + rows.length] as RankList | undefined;
  const rl = results[2 + rows.length] as RankList | undefined;
  const rv = results[3 + rows.length] as RankList | undefined;
  const homeTopItems = results[4 + rows.length] as Awaited<ReturnType<typeof getAreaWidgets>>;
  const homeSideItems = results[5 + rows.length] as Awaited<ReturnType<typeof getAreaWidgets>>;
  const sections = rows
    .map((row, i) => ({ row, posts: (sectionLists[i]?.items ?? []) as any[] }))
    .filter((s) => s.posts.length > 0);
  const rankings: { most_comments: any[]; most_likes: any[]; most_reads: any[] } | null = showRankings
    ? {
        most_comments: (rc as RankList).items.map(bmToRankPost),
        most_likes: (rl as RankList).items.map(bmToRankPost),
        most_reads: (rv as RankList).items.map(bmToRankPost),
      }
    : null;
  const rankOrder = bmRankOrderFrom(ts.rankOrder);
  const rankTabs = {
    labels: {
      most_comments: bmStrOr(ts.rankLabelComments, "热评文章"),
      most_likes: bmStrOr(ts.rankLabelLikes, "大家喜欢"),
      most_reads: bmStrOr(ts.rankLabelReads, "阅读最多"),
    },
    order: rankOrder,
    defaultTab: bmRankDefaultFrom(ts.rankDefault, rankOrder[0]),
  };

  return {
    head: homeHead,
    main: tc.home({
      hero: items.slice(0, 4),
      latest: items.slice(4, 12),
      liked: popular.items,
      random,
      cats,
      settings: { ...settings, t },
      recent: recent.items as any[],
      sections: sections as any,
      rankings,
      rankTabs,
      themeSettings: ts,
      blogIndex,
      showHero,
      bannerMax,
      recentCount,
      homeTop: R.widgetAreaHtml(homeTopItems, "container-np bmx-ad-area", t),
      sideWidgets: R.widgetAreaHtml(homeSideItems, "bmx-ad-area", t),
    }),
    notice,
  };
}

// ------------------------------------------------------------- list routing

async function blogList(payload: { page?: number }, ctx?: Ctx) {
  const locale = localeOf(ctx);
  const t = makeT(locale);
  // Sidebar batch pre-issues off the themeSlug/themeSettings reads below, so
  // its queries overlap the pager window's wave instead of following it.
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s === "default", t);
  const [settings, themeSlug, cfg, catRows, all, ts] = await Promise.all([
    getSettings(),
    themeSlugP,
    getPermalinkConfig(),
    listCategories(),
    listPosts({ status: "published", limit: 5, orderBy: "views" }),
    tsP,
  ]);
  // The chrome LAYOUT dialect this theme declares (see theme-api).
  const layout = themeLayout(themeSlug);

  // R148: window size from the shared helpers (dialects.ts) - the sitemap
  // computes page counts from the very same functions.
  const perPage = blogListSize(layout, settings.postsPerPage);
  const page = pageNum(payload.page);
  // R284: the /en tree lists PAIRED en posts (they are self-contained
  // documents with their own hreflang cluster) instead of re-listing the zh
  // body under a prefixed URL. The zh tree is untouched; the slice happens
  // in memory because windowed SQL for a synthetic subtree would need a
  // paired-join query — at en-tree scale (dozens, not thousands) the simple
  // slice is the leaner contract.
  const enOnly = locale !== DEFAULT_LOCALE;
  let window: { items: PostView[]; total: number };
  if (enOnly) {
    const paired = await listPosts({ status: "published", locale: "en", limit: 10000, windowCap: 10000 });
    window = {
      items: paired.items.slice((page - 1) * perPage, page * perPage),
      total: paired.items.length,
    };
  } else {
    window = await listPosts({
      status: "published",
      locale: DEFAULT_LOCALE,
      limit: perPage,
      offset: (page - 1) * perPage,
    });
  }
  const { items, total } = window;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  // R146: an out-of-range page used to render a 200 with an empty window (a
  // soft-404 crawlers would happily index). A page past the last one is gone.
  if (page > totalPages) return { notFound: true };
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const blogIndex = blogIndexUrlFor(cfg);
  const [widgets, drawerPosts, sidebarData] = await sideP;
  const tc = getThemeChrome(themeSlug);

  const siteTitle = settings.siteTitle ?? "";
  const seoTitle = t("list.seo_title", { site: siteTitle });
  // R146: paginated pages SELF-canonicalise - page 2+ used to emit canonical
  // (and og:url) pointing at page 1, telling crawlers the paginated window is
  // a duplicate of the index. The title also gains a page marker so SERP
  // snippets of consecutive pages can differ.
  const blogHeadTitle = page > 1 ? `${seoTitle} - ${t("list.seo_page", { n: page })}` : seoTitle;
  // og/twitter image must be absolute (OG spec); prefix origin for a relative logo.
  const listOgImage = R.esc(R.socialImage(settings.logoUrl, ctx?.origin ?? "", settings.ogImageUrl));
  const blogUrl = `${ctx?.origin ?? ""}${canonicalPath(blogIndex, locale)}`;
  const blogPageUrl = page > 1 ? `${blogUrl}?page=${page}` : blogUrl;
  // One batched read for this window: the ids the visitor already liked, for
  // the payload's `likedIds` AND the items' own `liked` flags (same round trip).
  const likedP = likedPFor(ctx, items);
  return {
    likedIds: [...(await likedP)].sort((a, b) => a - b),
    headTitle: blogHeadTitle,
    head:
      `<link rel="canonical" href="${R.esc(blogPageUrl)}">` +
      `<meta name="description" content="${R.esc(settings.siteDescription ?? "")}">` +
      `<meta name="robots" content="${R.robotsFor(settings.seoRobots)}">` +
      `<meta property="og:title" content="${R.esc(blogHeadTitle)}">` +
      `<meta property="og:description" content="${R.esc(settings.siteDescription ?? "")}">` +
      `<meta property="og:url" content="${R.esc(blogPageUrl)}">` +
      `<meta property="og:type" content="website">` +
      `<meta property="og:site_name" content="${R.esc(siteTitle)}">` +
      (listOgImage ? `<meta property="og:image" content="${listOgImage}">` : "") +
      `<meta name="twitter:card" content="${R.twitterCardKind(settings.twitterCard, listOgImage)}">` +
      `<meta name="twitter:title" content="${R.esc(blogHeadTitle)}">` +
      `<meta name="twitter:description" content="${R.esc(settings.siteDescription ?? "")}">` +
      (listOgImage ? `<meta name="twitter:image" content="${listOgImage}">` : "") +
      R.collectionJsonLd({
        url: blogPageUrl,
        title: blogHeadTitle,
        description: settings.siteDescription ?? "",
        inLanguage: locale,
        items: items.map((p) => ({ title: p.title, url: `${ctx?.origin ?? ""}${p.url}` })),
      }) +
      R.breadcrumbListJsonLd([
        { name: t("crumb.home"), url: `${ctx?.origin ?? ""}${canonicalPath("/", locale)}` },
        { name: t("list.all"), url: blogUrl },
      ]),
    main: tc.listPage({

      title: layout === "bluemix" ? t("list.latest_bm", { n: total }) : t("list.all"),
      sub: t("list.sub", { n: total, page, total: totalPages }),
      items: markLiked(items, await likedP),
      page,
      totalPages,
      hrefFor: (p) => paginate(blogIndex, p),
      hero: all.items,
      cats,
      blogIndex,
      bannerMax: bmClamp(ts.bannerMaxCount, 5, 1, 10),
      activeHref: blogIndex,
      variant: "blog",
      widgets,
      drawerPosts,
      sidebarData,
      settings: { ...settings, t },
      themeSettings: ts,

      total,
    }),
  };
}

async function categoryList(payload: { slug: string; page?: number }, ctx: Ctx) {
  const locale = localeOf(ctx);
  const t = makeT(locale);
  const page = pageNum(payload.page);
  // Sidebar batch pre-issues off the themeSlug/themeSettings reads below
  // (same pattern as blogList).
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s === "default", t);
  const [category, settings, cfg, themeSlug, catRows, ts] = await Promise.all([
    getCategoryBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
    themeSlugP,
    listCategories(),
    tsP,
  ]);
  // The chrome LAYOUT dialect this theme declares (see theme-api).
  const layout = themeLayout(themeSlug);
  if (!category) return { notFound: true };
  const isSk = layout === "skyscraper";
  // 0 means "follow the admin setting" (skyscraper); every other dialect
  // carries a fixed page size in its profile.
  const catPerPage = categoryListSize(layout, settings.postsPerPage);
  // Category listing: memoize the page's post window for 2 minutes (a new
  // post surfaces on refresh or an admin write invalidates by TTL).
  const catKey = `cat:${payload.slug}:${page}:${themeSlug}`;
  const cachedCat = kvGet<{ items: any[]; total: number }>(catKey);
  // R146: every layout windows for real. Non-skyscraper layouts used to pass
  // `offset: 0` plus a `page` option that PostQuery has never had (a silently
  // ignored property) - so /cat?page=2 rendered the IDENTICAL window as page
  // 1, and content past the dialect's page size was unreachable: the pager was
  // hidden too (showPager: false below). Same window math as blogList now.
  const { items, total } = cachedCat ?? await listPosts({
    status: "published",
    categorySlug: payload.slug,
    limit: catPerPage,
    offset: (page - 1) * catPerPage,
  });
  if (!cachedCat) kvSet(catKey, { items, total }, 120);
  const totalPages = Math.max(1, Math.ceil(total / catPerPage));
  // R146: out-of-range page = real 404, not a 200 with an empty window.
  if (page > totalPages) return { notFound: true };
  const catUrl = categoryUrlFor(cfg, category);
  const pluginHead = await pluginHeadHtml({
    kind: "taxonomy",
    siteTitle: settings.siteTitle ?? "",
    siteUrl: ctx.origin,
    title: category.name,
    description: category.description || settings.siteDescription || "",
    url: `${ctx.origin}${catUrl}`,
    breadcrumbs: [
      { label: t("crumb.home"), href: "/" },
      { label: category.name, href: catUrl },
    ],
  });
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const [widgets, drawerPosts, sidebarData] = await sideP;
  const tc = getThemeChrome(themeSlug);

  const sub = isSk
    ? `${category.description ? `<span>${category.description} · </span>` : ""}${t("list.sub", { n: total, page, total: totalPages })}`
    : "";
  const catCanonical = `${ctx.origin ?? ""}${canonicalPath(catUrl, locale)}`;
  // R146: self-canonical per page + page-marked title (was: every page
  // canonicalised to the bare category, i.e. page 2 labelled a duplicate).
  const catPageUrl = page > 1 ? `${catCanonical}?page=${page}` : catCanonical;
  const catHeadTitle =
    `${t("list.category_title", { name: category.name })} - ${settings.siteTitle ?? ""}` +
    (page > 1 ? ` - ${t("list.seo_page", { n: page })}` : "");
  const catOgImage = R.esc(R.socialImage(settings.logoUrl, ctx.origin ?? "", settings.ogImageUrl));
  const catDesc = category.description || settings.siteDescription || "";
  // One batched read for this window: the ids the visitor already liked, for
  // the payload's `likedIds` AND the items' own `liked` flags (same round trip).
  const likedP = likedPFor(ctx, items);
  return {
    likedIds: [...(await likedP)].sort((a, b) => a - b),
    headTitle: catHeadTitle,
    head:
      `<link rel="canonical" href="${R.esc(catPageUrl)}">` +
      // R160: the category's own feed is discoverable from the category page.
      `<link rel="alternate" type="application/rss+xml" title="${R.esc(t("list.category_title", { name: category.name }))}" href="${R.esc(catCanonical)}/feed.xml">` +
      // R162: and its JSON twin, same discovery contract.
      `<link rel="alternate" type="application/feed+json" href="${R.esc(catCanonical)}/feed.json">` +
      `<meta name="description" content="${R.esc(catDesc)}">` +
      `<meta name="robots" content="${R.robotsFor(settings.seoRobots)}">` +
      `<meta property="og:title" content="${R.esc(catHeadTitle)}">` +
      `<meta property="og:description" content="${R.esc(catDesc)}">` +
      `<meta property="og:url" content="${R.esc(catPageUrl)}">` +
      `<meta property="og:type" content="website">` +
      `<meta property="og:site_name" content="${R.esc(settings.siteTitle ?? "")}">` +
      (catOgImage ? `<meta property="og:image" content="${catOgImage}">` : "") +
      `<meta name="twitter:card" content="${R.twitterCardKind(settings.twitterCard, catOgImage)}">` +
      `<meta name="twitter:title" content="${R.esc(catHeadTitle)}">` +
      `<meta name="twitter:description" content="${R.esc(catDesc)}">` +
      (catOgImage ? `<meta name="twitter:image" content="${catOgImage}">` : "") +
      R.collectionJsonLd({
        url: catPageUrl,
        title: catHeadTitle,
        description: catDesc,
        inLanguage: locale,
        items: items.map((p) => ({ title: p.title, url: `${ctx.origin ?? ""}${p.url}` })),
      }) +
      R.breadcrumbListJsonLd([
        { name: t("crumb.home"), url: `${ctx.origin ?? ""}${canonicalPath("/", locale)}` },
        { name: category.name, url: catCanonical },
      ]),
    pluginHead,
    main: tc.listPage({
      title:
        layout === "bluemix" || layout === "codeman" || layout === "pseudolinear"
          ? category.name
          : t("list.category_title", { name: category.name }),
      crumbLast: category.name,
      sub,
      items: markLiked(items, await likedP),
      page,
      totalPages,
      hrefFor: (n) => paginate(catUrl, n),
      // R146: the pager shows whenever there is more to page through - it used
      // to be skyscraper-only, which (paired with the dead non-sk offset) made
      // content past the first window unreachable for every other layout.
      showPager: total > catPerPage,
      hero: items.slice(0, 5),
      cats,
      blogIndex: blogIndexUrlFor(cfg),
      bannerMax: bmClamp(ts.bannerMaxCount, 5, 1, 10),
      activeHref: catUrl,
      variant: "category",
      widgets,
      drawerPosts,
      sidebarData,
      settings: { ...settings, t },
      themeSettings: ts,

      titleIcon: layout === "bluemix"
        ? (ts.useCustomIcons !== false ? catIconName(category) : null)
        : (ts.useCustomIcons === true ? catIconName(category) : null),
      titleDesc: category.description || "",
    }),
  };
}

async function tagList(payload: { slug: string; page?: number }, ctx: Ctx) {
  const locale = localeOf(ctx);
  const t = makeT(locale);
  const page = pageNum(payload.page);
  // Sidebar batch pre-issues off the themeSlug/themeSettings reads below
  // (same pattern as blogList/categoryList).
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s !== "skyscraper", t);
  const [tag, settings, cfg, themeSlug, ts] = await Promise.all([
    getTagBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
    themeSlugP,
    tsP,
  ]);
  // The chrome LAYOUT dialect this theme declares (see theme-api).
  const layout = themeLayout(themeSlug);
  if (!tag) return { notFound: true };

  const isSk = layout === "skyscraper";
  const tagPerPage = tagListSize(layout, settings.postsPerPage);
  // R146: same fix as categoryList - non-skyscraper layouts passed offset 0
  // (with no page option existing), so /tag?page=2 was byte-identical to
  // page 1 and content past the window was unreachable. Real windowing now.
  const { items, total } = await listPosts({
    status: "published",
    tagSlug: payload.slug,
    limit: tagPerPage,
    offset: (page - 1) * tagPerPage,
  });
  const totalPages = Math.max(1, Math.ceil(total / tagPerPage));
  // R146: out-of-range page = real 404, not a 200 with an empty window.
  if (page > totalPages) return { notFound: true };
  const tagUrl = tagUrlFor(cfg, tag);
  const pluginHead = await pluginHeadHtml({
    kind: "taxonomy",
    siteTitle: settings.siteTitle ?? "",
    siteUrl: ctx.origin,
    title: `#${tag.name}`,
    description: settings.siteDescription || "",
    url: `${ctx.origin}${tagUrl}`,
    breadcrumbs: [
      { label: t("crumb.home"), href: "/" },
      { label: `#${tag.name}`, href: tagUrl },
    ],
  });
  const [widgets, drawerPosts, sidebarData] = await sideP;
  const tc = getThemeChrome(themeSlug);

  const contentTc = isSk ? tc : getThemeChrome("default");
  const tagCanonical = `${ctx.origin ?? ""}${canonicalPath(tagUrl, locale)}`;
  // R146: self-canonical per page + page-marked title (mirrors category/blog).
  const tagPageUrl = page > 1 ? `${tagCanonical}?page=${page}` : tagCanonical;
  const tagHeadTitle =
    `${t("list.tag_title", { name: tag.name })} - ${settings.siteTitle ?? ""}` +
    (page > 1 ? ` - ${t("list.seo_page", { n: page })}` : "");
  const tagOgImage = R.esc(R.socialImage(settings.logoUrl, ctx.origin ?? "", settings.ogImageUrl));
  const tagDesc = settings.siteDescription || "";
  // One batched read for this window: the ids the visitor already liked, for
  // the payload's `likedIds` AND the items' own `liked` flags (same round trip).
  const likedP = likedPFor(ctx, items);
  return {
    likedIds: [...(await likedP)].sort((a, b) => a - b),
    headTitle: tagHeadTitle,
    head:
      `<link rel="canonical" href="${R.esc(tagPageUrl)}">` +
      // R160: the tag's own feed is discoverable from the tag page.
      `<link rel="alternate" type="application/rss+xml" title="${R.esc(t("list.tag_title", { name: tag.name }))}" href="${R.esc(tagCanonical)}/feed.xml">` +
      // R162: and its JSON twin (no title: JSON Feed alternates carry none).
      `<link rel="alternate" type="application/feed+json" href="${R.esc(tagCanonical)}/feed.json">` +
      `<meta name="description" content="${R.esc(tagDesc)}">` +
      `<meta name="robots" content="${R.robotsFor(settings.seoRobots)}">` +
      `<meta property="og:title" content="${R.esc(tagHeadTitle)}">` +
      `<meta property="og:description" content="${R.esc(tagDesc)}">` +
      `<meta property="og:url" content="${R.esc(tagPageUrl)}">` +
      `<meta property="og:type" content="website">` +
      `<meta property="og:site_name" content="${R.esc(settings.siteTitle ?? "")}">` +
      (tagOgImage ? `<meta property="og:image" content="${tagOgImage}">` : "") +
      `<meta name="twitter:card" content="${R.twitterCardKind(settings.twitterCard, tagOgImage)}">` +
      `<meta name="twitter:title" content="${R.esc(tagHeadTitle)}">` +
      `<meta name="twitter:description" content="${R.esc(tagDesc)}">` +
      (tagOgImage ? `<meta name="twitter:image" content="${tagOgImage}">` : "") +
      R.collectionJsonLd({
        url: tagPageUrl,
        title: tagHeadTitle,
        description: tagDesc,
        inLanguage: locale,
        items: items.map((p) => ({ title: p.title, url: `${ctx.origin ?? ""}${p.url}` })),
      }) +
      R.breadcrumbListJsonLd([
        { name: t("crumb.home"), url: `${ctx.origin ?? ""}${canonicalPath("/", locale)}` },
        { name: `#${tag.name}`, url: tagCanonical },
      ]),
    pluginHead,
    main: contentTc.listPage({
      title: t("list.tag_title", { name: tag.name }),
      crumbLast: `#${tag.name}`,

      sub: isSk ? t("list.sub", { n: total, page, total: totalPages }) : "",
      items: markLiked(items, await likedP),
      page,
      totalPages,
      hrefFor: (n) => paginate(tagUrl, n),
      // R146: pager whenever there is more to page through (was skyscraper-only).
      showPager: total > tagPerPage,
      variant: "term",
      widgets,
      drawerPosts,

      sidebarData,
      settings: { ...settings, t },
      themeSettings: ts,
    }),
  };
}

/**
 * R180: the public author archive, `/author/<id>`.
 *
 * Why id and not a slug or the name: `users.name` carries a UNIQUE index but
 * there is no slug column, and an email is a private address the site must not
 * publish (the feeds already emit display names only). The id is stable across
 * renames, which matters because a theme byline and every post view carry it —
 * a slug would break every existing link the moment someone edited their
 * display name. Nothing private leaves this loader: `getPublicAuthor` projects
 * id/name/avatar/bio and the archive 404s when the account has no public post,
 * so it never becomes a thin-content page a crawler can index.
 */
async function authorList(payload: { authorId: number; page?: number }, ctx: Ctx) {
  const locale = localeOf(ctx);
  const t = makeT(locale);
  const page = pageNum(payload.page);
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s !== "skyscraper", t);
  const [author, settings, cfg, themeSlug, ts] = await Promise.all([
    getPublicAuthor(payload.authorId),
    getSettings(),
    getPermalinkConfig(),
    themeSlugP,
    tsP,
  ]);
  if (!author) return { notFound: true };
  const origin = ctx.origin ?? "";
  // The listing window follows the post index: an author archive is a plain
  // "the posts, filtered" listing, so the admin's own per-page setting has to
  // move it — categoryListSize is dialect-fixed and would ignore it.
  const layout = themeLayout(themeSlug);
  const isSk = layout === "skyscraper";
  const perPage = blogListSize(layout, settings.postsPerPage);
  const aKey = `author:${payload.authorId}:${page}:${themeSlug}`;
  const cachedA = kvGet<{ items: any[]; total: number }>(aKey);
  const { items, total } = cachedA ?? (await listPosts({
    status: "published",
    authorId: payload.authorId,
    limit: perPage,
    offset: (page - 1) * perPage,
  }));
  if (!cachedA) kvSet(aKey, { items, total }, 120);
  if (total === 0) return { notFound: true };
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page > totalPages) return { notFound: true };
  const authorUrl = authorUrlFor(author.id);
  const bio = (author.bio ?? "").trim();
  const desc = bio || settings.siteDescription || "";
  const pluginHead = await pluginHeadHtml({
    kind: "taxonomy",
    siteTitle: settings.siteTitle ?? "",
    siteUrl: ctx.origin,
    title: t("list.author_title", { name: author.name }),
    description: desc,
    url: `${origin}${authorUrl}`,
    breadcrumbs: [
      { label: t("crumb.home"), href: "/" },
      { label: author.name, href: authorUrl },
    ],
  });
  const [widgets, drawerPosts, sidebarData] = await sideP;
  const tc = getThemeChrome(themeSlug);
  const avatar = author.avatarUrl
    ? author.avatarUrl.startsWith("http")
      ? author.avatarUrl
      : `${origin}${author.avatarUrl}`
    : "";
  const authorCanonical = `${origin}${canonicalPath(authorUrl, locale)}`;
  const authorPageUrl = page > 1 ? `${authorCanonical}?page=${page}` : authorCanonical;
  const authorHeadTitle =
    `${t("list.author_title", { name: author.name })} - ${settings.siteTitle ?? ""}` +
    (page > 1 ? ` - ${t("list.seo_page", { n: page })}` : "");
  // One batched read for this window: the ids the visitor already liked, for
  // the payload's `likedIds` AND the items' own `liked` flags (same round trip).
  const likedP = likedPFor(ctx, items);
  return {
    likedIds: [...(await likedP)].sort((a, b) => a - b),
    headTitle: authorHeadTitle,
    head:
      `<link rel="canonical" href="${R.esc(authorPageUrl)}">` +
      // R182: the author's own feed, discoverable exactly like a category's.
      `<link rel="alternate" type="application/rss+xml" title="${R.esc(t("list.author_title", { name: author.name }))}" href="${R.esc(authorCanonical)}/feed.xml">` +
      `<link rel="alternate" type="application/feed+json" href="${R.esc(authorCanonical)}/feed.json">` +
      `<meta name="description" content="${R.esc(desc)}">` +
      // og:type=profile is the dialect a social card expects for a person page;
      // the avatar only travels when it is absolute (the OG spec drops
      // relative images silently).
      `<meta property="og:type" content="profile">` +
      `<meta property="og:title" content="${R.esc(t("list.author_title", { name: author.name }))}">` +
      `<meta property="og:url" content="${R.esc(authorPageUrl)}">` +
      `<meta property="og:description" content="${R.esc(desc)}">` +
      `<meta property="og:site_name" content="${R.esc(settings.siteTitle ?? "")}">` +
      (avatar ? `<meta property="og:image" content="${R.esc(avatar)}">` : "") +
      `<meta name="robots" content="${R.robotsFor(settings.seoRobots)}">` +
      // Person entity, joined to the site's own WebSite @id so the two merge
      // into one graph instead of competing. No email, no role, no ids of
      // posts the author cannot show — `getPublicAuthor` already filtered the
      // row down to what a stranger may read.
      R.jsonLd({
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        name: authorHeadTitle,
        url: authorPageUrl,
        isPartOf: { "@id": `${origin}/#website` },
        mainEntity: {
          "@type": "Person",
          "@id": `${origin}${authorUrl}#person`,
          name: author.name,
          url: `${origin}${authorUrl}`,
          ...(bio ? { description: bio } : {}),
          ...(avatar ? { image: avatar } : {}),
        },
      }),
    pluginHead,
    main: tc.listPage({
      title: t("list.author_title", { name: author.name }),
      crumbLast: author.name,
      sub: isSk
        ? `${bio ? `<span>${R.esc(bio)} · </span>` : ""}${t("list.sub", { n: total, page, total: totalPages })}`
        : "",
      items: markLiked(items, await likedP),
      page,
      totalPages,
      hrefFor: (n: number) => paginate(authorUrl, n),
      showPager: total > perPage,
      variant: "term",
      widgets,
      drawerPosts,
      sidebarData,
      settings: { ...settings, t },
      themeSettings: ts,
    }),
  };
}

async function search(payload: { q?: string; page?: number; all?: boolean }, ctx?: Ctx) {
  const locale = localeOf(ctx);
  const t = makeT(locale);
  const q = (payload.q ?? "").trim();
  const cleaned = q;
  // R153: every other list loader clamps through pageNum() - search was the
  // last one reading the raw query value, so ?page=0 / ?page=-3 reached
  // listPosts as a NEGATIVE offset (SQL error on the paged dialects) and
  // junk like ?page=abc as NaN.
  const page = pageNum(payload.page);
  // All reads below (settings, themeSlug, sidebar batch) pre-issue here so
  // they pipeline with the results query instead of queueing behind it; the
  // old shape awaited settings -> themeSlug serially, then re-read both
  // (getSettings twice, themeSettings alone) after the results wave.
  const settingsP = safe(getSettings());
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s === "default", t);
  const settings0 = await settingsP;
  const themeSlug = await themeSlugP;
  const layout = themeLayout(themeSlug);

  const isBm = layout === "bluemix";
  const isSk = layout === "skyscraper";
  // 0 means "follow the admin setting" (bluemix); every other dialect
  // carries a fixed page size in its profile.
  const perPage =
    dialectProfile(layout).searchPerPage ||
    Math.min(100, Math.max(1, Number(settings0.postsPerPage) || 10));
  // R153: every layout windows for real - the same defect R146 fixed for
  // category/tag (non-bluemix/non-skyscraper layouts were pinned to offset 0,
  // so /search?page=N answered the page-1 window while the pager stayed
  // hidden), and an out-of-range page is a 404, not a 200 with an empty
  // window. Search is noindex so crawlers shrugged at the soft-404, but a
  // user holding a stale page-2 link got a silent lie.
  const { items, total } = cleaned
    ? await listPosts({
        status: "published",
        search: cleaned,
        limit: perPage,
        offset: (page - 1) * perPage,
      })
    : { items: [] as PostView[], total: 0 };
  // Hot-terms telemetry (zero-result terms included); fire-and-forget inside recordSearchTerm.
  recordSearchTerm(cleaned, locale);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page > totalPages) return { notFound: true };
  // unique hit jumps straight to the post (?all=1 keeps the list). The
  // middleware 302s cold GETs; this branch only arms the client-side
  // location.replace during SPA navigation (middleware never runs there).
  if (cleaned && !payload.all && total === 1 && page === 1 && items[0]?.url) {
    return { redirect: items[0].url };
  }
  const hrefFor = (n: number) =>
    `/search?q=${encodeURIComponent(cleaned)}&page=${n}${payload.all ? "&all=1" : ""}`;
  const extra =
    cleaned && total > 1 && !payload.all
      ? `<div class="sk-search-all">${t("search.all_lead")}<a href="/search?q=${encodeURIComponent(
          cleaned,
        )}&all=1">${t("search.all_link")}</a></div>`
      : "";
  const [settings, ts] = await Promise.all([settingsP, tsP]);
  const [widgets, drawerPosts, sidebarData] = await sideP;

  const searchSiteTitle = settings.siteTitle ?? "";
  const searchTitle = cleaned
    ? isBm
      ? t("search.title_bm", { q: cleaned, n: total })
      : t("search.title_q", { q: cleaned })
    : t("search.title");
  const searchDesc = cleaned ? t("search.sub_found", { n: total }) : (settings.siteDescription ?? "");
  // F4: search-term highlight.
  const searchHighlight =
    `<script>(function(){var done=false;function run(){if(done)return;done=true;` +
    `var m=location.search.match(/[?&]q=([^&]*)/);if(!m)return;var q;` +
    `try{q=decodeURIComponent(m[1])}catch(e){return}` +
    `var words=q.trim().split(/\\s+/).filter(function(w){return w.length>0})` +
    `.map(function(w){return w.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')});` +
    `if(!words.length)return;` +
    `var re=new RegExp('('+words.join('|')+')','gi');` +
    `var has=new RegExp(words.join('|'),'i');` +
    `var root=document.querySelector('main')||document.body;if(!root)return;` +
    `var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(n){` +
    `var p=n.parentNode;if(!p||/^(script|style|mark)$/i.test(p.nodeName))return NodeFilter.FILTER_REJECT;` +
    `return n.nodeValue&&has.test(n.nodeValue)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;}});` +
    `var hits=[];while(w.nextNode())hits.push(w.currentNode);` +
    `hits.forEach(function(n){var s=n.nodeValue,last=0,mm,frag=document.createDocumentFragment();` +
    `re.lastIndex=0;while((mm=re.exec(s))){if(mm.index>last)frag.appendChild(document.createTextNode(s.slice(last,mm.index)));` +
    `var mk=document.createElement('mark');mk.textContent=mm[0];frag.appendChild(mk);` +
    `last=mm.index+mm[0].length;if(!mm[0].length)re.lastIndex++;}` +
    `if(last<s.length)frag.appendChild(document.createTextNode(s.slice(last)));` +
    `if(n.parentNode)n.parentNode.replaceChild(frag,n);});}` +
    `if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();})();</script>`;
  // A search-results page is a query view, not content: keep it out of the
  // index but let the crawler follow its links, and self-canonicalise to the
  // locale-aware /search path.
  const searchCanonical = `${ctx?.origin ?? ""}${canonicalPath("/search", locale)}`;
  const searchOgImage = R.esc(R.socialImage(settings.logoUrl, ctx?.origin ?? "", settings.ogImageUrl));
  const searchHead =
    `<link rel="canonical" href="${R.esc(searchCanonical)}">` +
    `<meta name="robots" content="noindex, follow">` +
    `<meta property="og:title" content="${R.esc(searchTitle)}">` +
    `<meta property="og:description" content="${R.esc(searchDesc)}">` +
    `<meta property="og:url" content="${R.esc(searchCanonical)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="${R.esc(searchSiteTitle)}">` +
    (searchOgImage ? `<meta property="og:image" content="${searchOgImage}">` : "") +
    `<meta name="twitter:card" content="${R.twitterCardKind(settings.twitterCard, searchOgImage)}">` +
    `<meta name="twitter:title" content="${R.esc(searchTitle)}">` +
    `<meta name="twitter:description" content="${R.esc(searchDesc)}">` +
    (searchOgImage ? `<meta name="twitter:image" content="${searchOgImage}">` : "") +
    searchHighlight;
  // One batched read for this window: the ids the visitor already liked, for
  // the payload's `likedIds` AND the items' own `liked` flags (same round trip).
  const likedP = likedPFor(ctx, items);
  return {
    likedIds: [...(await likedP)].sort((a, b) => a - b),
    head: searchHead,
    main: getThemeChrome(themeSlug || "skyscraper").listPage({

      title: searchTitle,

      sub: isBm || layout === "codeman" || layout === "pseudolinear"
        ? ""
        : cleaned
          ? isSk
            ? t("search.sub_results", { n: total, page, total: totalPages })
            : t("search.sub_found", { n: items.length })
          : isSk
            ? t("search.sub_hint")
            : "",
      items: markLiked(items, await likedP),
      page,
      totalPages,
      hrefFor,
      // R153: pager whenever there is more to page through (was bluemix/
      // skyscraper-only, paired with the dead non-paged offset above).
      showPager: total > perPage,
      extra: isBm || isSk ? extra : "",
      variant: "search",
      titleIcon: isBm ? null : "search",
      query: cleaned,
      widgets,
      drawerPosts,

      sidebarData,
      settings: { ...settings, t },
      themeSettings: ts,
      emptyHint: isBm && !cleaned ? t("search.empty_hint") : undefined,
    }),
  };
}

// -------------------------------------------------------------- post detail

// Attach a no-op rejection handler so a read orphaned by the notFound
// early-return cannot surface as an unhandled rejection; the returned
// promise still rejects for the real consumer below.
function safe<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

// Pre-issued sidebar batch shared by the list loaders (blog/category/tag/
// search): the widget-area, drawer-post and sidebar reads all gate on the
// theme slug, so calling this at the top of a loader chains them off the
// themeSlug/themeSettings reads and their queries issue mid-wave instead of
// forming their own wave after the loader's main reads. Await the returned
// promise where the batch used to sit; the noop catch keeps a notFound
// early return from orphaning it.
function sidebarBatchP(
  themeSlugP: Promise<string>,
  tsP: Promise<Record<string, unknown>>,
  want: (themeSlug: string) => boolean,
  tr?: Translate,
): Promise<[string, PostView[] | undefined, Awaited<ReturnType<typeof defaultSidebarData>>]> {
  const p = Promise.all([themeSlugP, tsP]).then(([s, t]) =>
    Promise.all([
      sideWidgetsFor(s, tr),
      bmixDrawerPosts(s),
      defaultSidebarData(want(s), t.useCustomIcons === true),
    ]),
  );
  p.catch(() => {});
  return p;
}

async function postDetail(
  payload: { slug: string; preloaded?: PostRow | null },
  ctx: Ctx,
) {
  // Pre-issue every read that does not depend on the post row: they pipeline
  // with getPostRow instead of queueing behind it. The old shape chained three
  // serial links before the reads wave (getPost -> themeSlug -> wave), each a
  // full Neon RTT on a cold view; the themeSlug read in particular sat
  // between the post fetch and the wave doing nothing but gating it.
  const themeSlugP = safe(getActiveThemeSlug());
  const settingsP = safe(getSettings());
  const popularP = safe(popularPosts(4));
  const randomP = safe(randomPosts(12));
  const cfgP = safe(getPermalinkConfig());
  // resolveSitePath already ran the same lookup to decide this is a post —
  // it hands over the RAW row, and hydration joins the reads wave below:
  // hydrating in resolveSitePath (the old getPost) cost a dedicated round
  // trip between the row select and everything else on a cold view.
  let row = payload.preloaded ?? (await getPostRow(payload.slug));
  // F7 (draft/scheduled preview): a manager (content:update:any) or the
  // post's own author may open the public URL of an unpublished post and see
  // it with a preview banner - everyone else keeps the 404. Covers drafts,
  // archived posts and scheduled (future publishedAt) posts alike.
  let previewing = false;
  if (!row && ctx?.user) {
    const u = ctx.user as { id: number; role: import("./schema.js").Role };
    const candidate = await getPostRow(payload.slug, { preview: true });
    if (candidate && (can(u.role, "content:update:any") || candidate.post.authorId === u.id)) {
      row = candidate;
      previewing = true;
    }
  }
  if (!row) return { notFound: true };
  const locale = localeOf(ctx);
  const t = makeT(locale);
  const themeSlug = await themeSlugP;
  const layout = themeLayout(themeSlug);
  const postId = row.post.id;
  // 上一篇/下一篇: one UNION ALL statement for both neighbours, issued inside
  // the reads wave (the key comes off the raw row, so nothing gates it).
  // adjacentKeyOf mirrors the SQL's coalesce(published_at, created_at).
  const adjacentP = safe(getAdjacentPosts(postId, adjacentKeyOf(row.post)));

  const relatedN = dialectProfile(layout).relatedN;
  // Only three themes render `related` (bluemix / pseudolinear / codeman);
  // the default theme's post page reads relatedTaxonomy alone and skyscraper
  // reads neither. Computing the date-based set unconditionally ran ~6
  // pointless queries per post view on every per-cookie render-cache miss.
  const usesRelated = layout === "bluemix" || layout === "pseudolinear" || layout === "codeman";
  const highlight = layout === "skyscraper" || layout === "bluemix";
  const isDefault = layout === "default";
  const isBluemix = layout === "bluemix";
  // Bluemix renders both areas too (PostPage.tsx: sidebar after PostSidebar).
  // Every theme but skyscraper renders a sidebar area, so the sidebar read is
  // not gated on widgetAreas - codeman/pseudolinear paint it through `widgets`.
  const widgetAreas = isDefault || isBluemix;
  const wantsSidebar = layout !== "skyscraper";
  // The view-count write used to be awaited AFTER the reads block — a whole
  // extra serial round trip on Neon (~550ms) tacked onto every render-cache
  // miss. It reads nothing the reads produce, so it rides the same wave and
  // is still awaited (best effort: a stats failure never breaks the page).
  // R255: the Referer header rides along for the traffic-source breakdown.
  // Passed as-is, so the two shapes stay distinct: a loader called without the
  // field (a script, a test, a synthetic request) yields `undefined` and the
  // columns stay null, while a real request with NO Referer header yields ""
  // and is classified 'direct' - which is exactly what that traffic is.
  const viewsWrite = (async () => {
    if (ctx.ip || ctx.ua) {
      try {
        await incrementViews(postId, ctx.ip, ctx.ua, ctx.referer);
      } catch {
        /* */
      }
    }
  })();
  // Has THIS visitor liked this post? Issued alongside the wave (it depends on
  // nothing the wave produces), so the backfill adds no serial round trip; a
  // request with no visitor_key cookie answers false without touching the DB.
  const likedP = likedPostsFor(visitorKeyOf(ctx), [postId]).then((s) => s.has(postId));
  // One hydration, three consumers. The body render and the plugin head chain
  // off it, so body rendering (pure CPU without DB-backed shortcodes, one
  // round trip with them) overlaps the reads wave instead of running after it,
  // and the head follows the post instead of re-reading anything.
  const hydratedP = safe(hydrate(row, { preview: previewing }));
  const bodyHtmlP = hydratedP.then((p) => R.buildPostBody(p, "post", highlight));
  const pluginHeadP = Promise.all([hydratedP, settingsP])
    .then(([post, settings]) => ({
      kind: "post" as const,
      siteTitle: settings.siteTitle ?? "",
      siteUrl: ctx.origin,
      title: post.seoTitle || post.title,
      description: post.seoDescription || post.excerpt || settings.siteDescription || "",
      image: post.featuredImage || undefined,
      publishedAt: post.publishedAt ? new Date(post.publishedAt).toISOString() : null,
      updatedAt: post.updatedAt ? new Date(post.updatedAt).toISOString() : null,
      author: post.author?.name,
      url: `${ctx.origin}${post.url}`,
      breadcrumbs: [
        { label: t("crumb.home"), href: "/" },
        { label: post.title, href: post.url },
      ],
    }))
    .then((headContext) => pluginHeadHtml(headContext));
  // The default theme's sidebar bundle is five more queries on a cold 60s
  // window, and it needs the theme settings only to read `useCustomIcons`.
  // Pre-issuing it here folds the old second wave into the opening one.
  const tsP = isDefault ? safe(getActiveThemeSettings()) : null;
  const sideDataP = tsP
    ? tsP.then((t) => defaultSidebarData(true, t?.useCustomIcons === true))
    : null;
  // The wave: everything that needs no other read's result issues together -
  // hydration, the comments/related reads, the body render, the plugin head
  // and both widget areas. One Neon round trip on a cold view.
  const [
    post,
    bodyHtml,
    pluginHead,
    related,
    settings,
    items,
    popular,
    random,
    cfg,
    relatedTaxonomy,
    bottomItems,
    sideItems,
    sidebarData,
    adjacent,
  ] = await Promise.all([
    hydratedP,
    bodyHtmlP,
    pluginHeadP,
    usesRelated ? relatedPosts(postId, relatedN) : Promise.resolve([] as PostView[]),
    settingsP,
    listPostCommentsCached(postId, "post"),
    popularP,
    randomP,
    cfgP,
    layout === "default"
      ? relatedByTaxonomy(postId, dialectProfile(layout).taxonomyRelatedN)
      : Promise.resolve(undefined),
    widgetAreas
      ? getAreaWidgets(themeSlug, "post-bottom")
      : Promise.resolve<Awaited<ReturnType<typeof getAreaWidgets>>>([]),
    wantsSidebar
      ? getAreaWidgets(themeSlug, "sidebar")
      : Promise.resolve<Awaited<ReturnType<typeof getAreaWidgets>>>([]),
    sideDataP ?? Promise.resolve(undefined),
    adjacentP,
    viewsWrite,
  ]);
  const config = resolveCommentConfig(settings);
  const u = ctx.user as { id?: number; name?: string; email?: string } | undefined;
  const me = u && u.id ? { id: u.id, name: u.name ?? "", email: u.email ?? "" } : null;
  const commentsHtml = R.commentsBare({
    postId: post.id,
    postType: "post",
    open: post.commentStatus === "open",
    enabled: config.enabled,
    provider: config.provider,
    requireNameEmail: settings.requireNameEmail ?? false,

    requireAuthorUrl: settings.requireAuthorUrl ?? false,

    authorUrlLabel: t("comments.url_label"),
    defaultContent: config.defaultContent,
    me,
    items,
    avatar: config.avatar,
    config: { ...config },
    locale,
    t,
  });
  // post.meta filter (reading-time, . ): plugin rows on the meta line.
  const metaPayload = applyFilters<{ post: unknown; items: R.MetaItem[] }>(HOOKS.postMeta, {
    post: { ...post, plainText: R.blocksToPlainText(post.content) },
    items: [],
  });
  const tc = getThemeChrome(themeSlug);

  // Reading time from the rendered body: CJK counts per character (~400/min),
  // everything else per word (~200/min). Floor of 1 so short posts still read
  // as "about a minute". Rides the postMeta payload so every theme's meta row
  // (defMetaHtml, bluemix hero badges) picks it up in one place. wordCount /
  // minutes also feed the BlogPosting JSON-LD (timeRequired / wordCount).
  const readPlain = bodyHtml.replace(/<[^>]+>/g, " ");
  const readCjk = (readPlain.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  const readWords = readPlain.replace(/[\u4e00-\u9fff\u3040-\u30ff]/g, " ").split(/\s+/).filter(Boolean).length;
  const readMinutes = Math.max(1, Math.round(readCjk / 400 + readWords / 200));
  const readWordCount = readCjk + readWords;
  metaPayload.items.unshift({
    label: t("post.read_time"),
    value: t("post.read_minutes", { n: readMinutes }),
  });
  const metaHtml = metaPayload.items.length
    ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--muted)">${metaPayload.items.map((m) => `<span>${R.esc(m.label)}：${R.esc(m.value)}</span>`).join("")}</div>`
    : "";
  const tagsHtml = (post.tags || []).length
    ? `<div style="margin-top:32px;display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid var(--border);padding-top:24px">${(post.tags || []).map((t) => `<a href="${R.esc(t.url || tagUrlFor(cfg, t))}" style="font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--border);padding:4px 12px;border-radius:9999px">#${R.esc(t.name)}</a>`).join("")}</div>`
    : "";
  // R280: a paired post offers its counterpart inline. The zh reader sees
  // "Read the English version" under the tags; the en reader sees the mirror
  // label. The pair URL travels through ctx.pairSwitchTarget (resolveInner
  // resolved it through the real permalink config), so the two entry points
  // — this link and the chrome switcher — never disagree.
  const pairTarget = (ctx as { pairSwitchTarget?: string }).pairSwitchTarget;
  const pairLink = pairTarget
    ? `<div style="margin-top:16px"><a data-no-pjax data-locale-keep href="${R.esc(pairTarget)}" style="font-size:13px;color:var(--primary,var(--sk-primary,#2563eb));text-decoration:none">${t("post.read_translation")}</a></div>`
    : "";
  // The share modal's like button is rendered HERE, so the visitor's own like
  // state has to be on the object before that call. `likedP` was issued with the
  // reads wave (:1605), so this await costs no extra round trip; liked:false
  // passes the original object through and the markup stays byte-identical.
  const liked = await likedP;
  const postView = liked ? { ...post, liked: true } : post;
  const shareHtml = R.shareBar(postView, settings.siteTitle ?? "", settings.siteDescription ?? "");

  const defMetaHtml = metaPayload.items.length
    ? `<div class="mt-2 flex flex-wrap items-center gap-4 text-sm text-[var(--muted)]">${metaPayload.items.map((m) => `<span>${R.esc(m.label)}：${R.esc(m.value)}</span>`).join("")}</div>`
    : "";
  const defTagsHtml = (post.tags || []).length
    ? `<div class="mt-8 flex flex-wrap gap-2 border-t border-[var(--border)] pt-6">${(post.tags || []).map((t) => `<a href="${R.esc(t.url || tagUrlFor(cfg, t))}" class="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]">#${R.esc(t.name)}</a>`).join("")}</div>`
    : "";

  // Sidebar widgets for codeman/pseudolinear paint the area read in the
  // opening wave; the other themes return "" and use sidebarWidgets below.
  const widgets = sideWidgetsHtml(themeSlug, sideItems, t);
  const postBottom = widgetAreas
    ? R.widgetAreaHtml(bottomItems, isBluemix ? "model-wrapper bmx-ad-area" : "space-y-6", t)
    : "";
  const sidebarWidgets = widgetAreas
    ? R.widgetAreaHtml(sideItems, isBluemix ? "bmx-ad-area" : "space-y-6", t)
    : "";
  // F7: the preview banner rides the rendered main for managers/authors on
  // unpublished posts only - a fixed bar over the theme's own chrome.
  const previewBanner = previewing
    ? `<div style="position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#d97706;color:#fff;padding:6px 16px;text-align:center;font:600 14px/1.5 system-ui,sans-serif">` +
      `Preview mode: this content is not yet published (status: ${R.esc(post.status)}${post.publishedAt && new Date(post.publishedAt) > new Date() ? `, scheduled for ${new Date(post.publishedAt).toLocaleString("zh-CN")}` : ""}) — visible to administrators and the author only` +
      `</div>`
    : "";
  return {
    // Whether THIS visitor already liked the post (read issued above).
    liked,
    main: previewBanner + tc.postPage({
      post: postView,
      bodyHtml,
      related,
      relatedTaxonomy,
      popular,
      random,
      commentsHtml,
      metaHtml,
      defMetaHtml,
      // post.meta filter values (reading-time, . ) ride the bluemix hero card's.
      // badge row (original parity: PostPage.tsx meta={{ ..., badges }}).
      metaBadges: metaPayload.items.map((m) => m.value),
      metaItems: metaPayload.items,
      tagsHtml,
      defTagsHtml,
      pairLink,
      shareHtml,
      adjacentHtml: prefixLocaleUrls(
        adjacentHtml(adjacent, {
          older: t("adjacent.older"),
          newer: t("adjacent.newer"),
          aria: t("adjacent.aria"),
        }),
        locale,
      ),
      blogIndex: blogIndexUrlFor(cfg),
      widgets,
      postBottom,
      sidebarWidgets,

      sidebarData,
      settings: { ...settings, t },
      canonical: `${ctx.origin}${canonicalPath(post.url, locale)}`,
    }),
    head:
      // R216: publisher.logo is what makes a page eligible for Google's article
      // rich result. postHead falls back to the bundled brand mark when the
      // admin set no logo, so the field is never dropped.
      R.postHead(post, settings.siteTitle ?? "", defaultDescription(settings), ctx.origin, settings.logoUrl || R.BRAND_LOGO, { wordCount: readWordCount, minutes: readMinutes, canonical: `${ctx.origin}${canonicalPath(post.url, locale)}`, inLanguage: locale }, settings.ogImageUrl, settings.twitterCard, settings.seoRobots) +
      // rel=prev/next for the reading order (chronological neighbours). Only
      // present directions are emitted, so edge posts keep the head untouched.
      adjacentRelLinks(adjacent) +
      pluginHead,
  };
}

// -------------------------------------------------------------- page detail

async function pageDetail(
  payload: { slug: string; preloaded?: import("./pages.js").Page | null },
  ctx: Ctx,
) {
  // Same reuse contract as postDetail: resolveSitePath already fetched the
  // RAW page row to route here, and hydration joins the reads wave instead
  // of running ahead of it. themeSlug/settings pre-issue so they pipeline
  // with the page fetch; recentLimit's coupling to the theme resolves
  // through the promise chain instead of a serial await.
  const themeSlugP = safe(getActiveThemeSlug());
  const settingsP = safe(getSettings());
  const row = payload.preloaded ?? (await getPublishedPageRow(payload.slug));
  if (!row) return { notFound: true };
  const locale = localeOf(ctx);
  const t = makeT(locale);

  // One hydration, three consumers: the page, its rendered body and the plugin
  // head all chain off it, so body rendering (pure CPU without DB-backed
  // shortcodes, one round trip with them) overlaps the reads wave instead of
  // running after it, and the sidebar widgets need only the theme slug.
  const hydratedPageP = safe(hydratePage(row));
  const [page, bodyHtml, pluginHead, widgets, settings, recent, items, themeSlug] =
    await Promise.all([
      hydratedPageP,
      Promise.all([hydratedPageP, themeSlugP]).then(([p, s]) =>
        R.buildPostBody(p, "page", s === "skyscraper" || s === "bluemix"),
      ),
      Promise.all([hydratedPageP, settingsP])
        .then(([p, settings]) => ({
          kind: "page" as const,
          siteTitle: settings.siteTitle ?? "",
          siteUrl: ctx.origin,
          title: p.seoTitle || p.title,
          description: p.seoDescription || p.excerpt || settings.siteDescription || "",
          image: p.featuredImage || undefined,
          publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
          updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
          url: `${ctx.origin}${p.url}`,
          breadcrumbs: [
            { label: t("crumb.home"), href: "/" },
            { label: p.title, href: p.url },
          ],
        }))
        .then((headContext) => pluginHeadHtml(headContext)),
      themeSlugP.then(sideWidgetsFor),
      settingsP,
      themeSlugP
        .then((s) => listPosts({ status: "published", limit: s === "bluemix" ? 4 : 5 })),
      listPostCommentsCached(row.id, "page"),
      themeSlugP,
    ]);
  const config = resolveCommentConfig(settings);
  const u = ctx.user as { id?: number; name?: string; email?: string } | undefined;
  const me = u && u.id ? { id: u.id, name: u.name ?? "", email: u.email ?? "" } : null;
  const commentsHtml = R.commentsBare({
    postId: page.id,
    postType: "page",
    open: page.commentStatus === "open",
    enabled: config.enabled,
    provider: config.provider,
    requireNameEmail: settings.requireNameEmail ?? false,

    requireAuthorUrl: settings.requireAuthorUrl ?? false,

    authorUrlLabel: t("comments.url_label"),
    defaultContent: config.defaultContent,
    me,
    items,
    avatar: config.avatar,
    config: { ...config },
    locale,
    t,
  });
  const tc = getThemeChrome(themeSlug);

  // Page reading time (parity with postDetail): CJK chars / latin words off the
  // rendered body, floored at 1 minute. Feeds the WebPage JSON-LD.
  const pgPlain = bodyHtml.replace(/<[^>]+>/g, " ");
  const pgCjk = (pgPlain.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  const pgWords = pgPlain.replace(/[\u4e00-\u9fff\u3040-\u30ff]/g, " ").split(/\s+/).filter(Boolean).length;
  const pgMinutes = Math.max(1, Math.round(pgCjk / 400 + pgWords / 200));
  const pgWordCount = pgCjk + pgWords;

  return {
    main: tc.pagePage({
      page,
      bodyHtml,
      recent: recent.items,
      commentsHtml,

      widgets,
      settings: { ...settings, t },
    }),
    head:
      R.pageHead(page, settings.siteTitle ?? "", defaultDescription(settings), ctx.origin, settings.logoUrl || R.BRAND_LOGO, { wordCount: pgWordCount, minutes: pgMinutes, canonical: `${ctx.origin}${canonicalPath(page.url, locale)}`, inLanguage: locale }, settings.ogImageUrl, settings.twitterCard, settings.seoRobots) +
      pluginHead,
  };
}

// ------------------------------------------------------------- page directory

/**
 * R178: the public page directory at the page base (`/pages`). A page has
 * always had a URL, but nothing linked one: an install's whole page tree was
 * discoverable only through the sitemap, which is how a CMS ends up with
 * orphaned documents. Weight order is the author's menu order (pages.order,
 * then recency) and the nesting follows parentId.
 */
async function pageIndex(ctx: Ctx) {
  const locale = localeOf(ctx);
  const t = makeT(locale);
  const [settings, cfg, pages] = await Promise.all([
    getSettings(),
    getPermalinkConfig(),
    // R247: the page directory lists the whole site - limit:500 was silently
    // clamped to 100 by the visitor ceiling.
    listPublishedPages({ limit: 500, windowCap: MACHINE_WINDOW_CAP }),
  ]);
  type DirPage = (typeof pages.items)[number];
  const siteTitle = settings.siteTitle ?? "";
  const desc = settings.siteDescription ?? "";
  const indexUrl = pageIndexUrlFor(cfg);
  const canonical = `${ctx?.origin ?? ""}${canonicalPath(indexUrl, locale)}`;

  const byId = new Map<number, DirPage>(pages.items.map((p) => [p.id, p]));
  const kids = new Map<number, DirPage[]>();
  const roots: DirPage[] = [];
  for (const p of pages.items) {
    const parent = p.parentId == null ? null : byId.get(p.parentId);
    if (!parent) {
      // A child whose parent is unpublished (or gone) surfaces at the root:
      // dropping it with its parent would hide published content from readers,
      // crawlers and the sitemap-fed index alike.
      roots.push(p);
      continue;
    }
    const bucket = kids.get(parent.id);
    if (bucket) bucket.push(p);
    else kids.set(parent.id, [p]);
  }

  // Depth-first, so the JSON-LD positions match the visible order. `seen` only
  // blocks a parentId cycle - a page has exactly one parent, so a legitimate
  // node is never reached twice.
  const flat: DirPage[] = [];
  const liOf = (p: DirPage, seen: Set<number>): string => {
    seen.add(p.id);
    flat.push(p);
    const sub = (kids.get(p.id) ?? [])
      .filter((c) => !seen.has(c.id))
      .map((c) => liOf(c, seen))
      .join("");
    const excerpt = p.excerpt
      ? `<p class="mt-1 text-sm" style="color:var(--muted)">${R.esc(p.excerpt)}</p>`
      : "";
    return (
      `<li class="rounded-xl border p-4" style="border-color:var(--border);background:var(--surface)">` +
      `<a class="block text-base font-semibold transition hover:underline" style="color:var(--text)" href="${R.esc(p.url)}">${R.esc(p.title)}</a>` +
      excerpt +
      (sub ? `<ul class="mt-3 space-y-2 border-l pl-4" style="border-color:var(--border)">${sub}</ul>` : "") +
      `</li>`
    );
  };
  const seen = new Set<number>();
  const list = roots.map((p) => liOf(p, seen)).join("");
  const main =
    `<header class="mb-8">` +
    `<h1 class="text-3xl font-bold" style="color:var(--text)">${t("pages.title")}</h1>` +
    `<p class="mt-2 text-sm" style="color:var(--muted)">${t("pages.count", { n: pages.total })}</p>` +
    `</header>` +
    (list
      ? `<ul class="space-y-3">${list}</ul>`
      : `<p class="rounded-2xl border p-10 text-center text-sm" style="border-color:var(--border);background:var(--surface);color:var(--muted)">${t("pages.empty")}</p>`);

  const ogImage = R.esc(R.socialImage(settings.logoUrl, ctx?.origin ?? "", settings.ogImageUrl));
  const headTitle = `${t("pages.title")} - ${siteTitle}`;
  return {
    headTitle,
    head:
      `<link rel="canonical" href="${R.esc(canonical)}">` +
      `<meta name="description" content="${R.esc(desc)}">` +
      `<meta name="robots" content="${R.robotsFor(settings.seoRobots)}">` +
      `<meta property="og:title" content="${R.esc(headTitle)}">` +
      `<meta property="og:description" content="${R.esc(desc)}">` +
      `<meta property="og:url" content="${R.esc(canonical)}">` +
      `<meta property="og:type" content="website">` +
      `<meta property="og:site_name" content="${R.esc(siteTitle)}">` +
      (ogImage ? `<meta property="og:image" content="${ogImage}">` : "") +
      `<meta name="twitter:card" content="${R.twitterCardKind(settings.twitterCard, ogImage)}">` +
      `<meta name="twitter:title" content="${R.esc(headTitle)}">` +
      `<meta name="twitter:description" content="${R.esc(desc)}">` +
      R.jsonLd({
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: t("pages.title"),
        url: canonical,
        numberOfItems: flat.length,
        itemListOrder: "https://schema.org/ItemListOrderAscending",
        itemListElement: flat.map((p, i) => ({
          "@type": "ListItem",
          position: i + 1,
          url: `${ctx?.origin ?? ""}${p.url}`,
          name: p.title,
        })),
      }),
    main,
  };
}

// ---------------------------------------------------------------- archives

const CALENDAR_DAYS_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-days" style="color:var(--accent)">` +
  `<path d="M8 2v4"></path><path d="M16 2v4"></path><rect width="18" height="18" x="3" y="4" rx="2"></rect><path d="M3 10h18"></path>` +
  `<path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path>` +
  `<path d="M8 18h.01"></path><path d="M12 18h.01"></path><path d="M16 18h.01"></path></svg>`;
const EYE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye">` +
  `<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path>` +
  `<circle cx="12" cy="12" r="3"></circle></svg>`;

/** Known post formats. An unknown format renders no badge, as before. */
const POST_FORMATS = [
  "standard",
  "aside",
  "quote",
  "link",
  "image",
  "gallery",
  "video",
  "audio",
  "status",
];

/** The post-format badge label, translated. Unknown formats return null. */
function postFormatLabel(format: string | undefined, t: Translate): string | null {
  const key = format || "standard";
  return POST_FORMATS.includes(key) ? t(`format.${key}`) : null;
}

async function archives(payload: { year?: number; month?: number; page?: number }, ctx?: Ctx) {
  const archLocale = localeOf(ctx);
  const t = makeT(archLocale);
  const year = Number(payload.year) || 0;
  const month = Number(payload.month) || 0;
  // R233: the window used to be a hard 1000-row slice (R232 only admitted it
  // in the header). It is now a real page window, so the page stays the same
  // size forever instead of growing with the archive.
  const page = pageNum(payload.page);
  const ARCH_PER_PAGE = 100;
  const esc = R.esc;
  // Archives scans the requested window on every visit: memoize the read set
  // for 5 minutes (archives change rarely, and a new post shows up on the
  // next refresh or an admin write). R233: the page is part of the key now -
  // every page is its own window, not one 1000-row slice for all of them.
  const archKey = `archives:${year}:${month}:${page}`;
  const cached = kvGet<{ settings: any; index: any; total: number; items: any[] }>(archKey);
  let settings: any;
  let index: { year: number; months: { month: number; count: number }[]; total: number }[];
  let total: number;
  let items: any[];
  if (cached) {
    ({ settings, index, total, items } = cached);
  } else {
    // counts() is the same scalar the old `listPosts({ limit: 1 })` read out of
    // its window total - identical predicate (status=published + publishedAt
    // null-or-past) - but as ONE memoized scalar subquery instead of a whole
    // list pipeline: the limit-1 call still ran the pinned resolution (2
    // queries), the main select, attachTaxonomies (2) and attachPostMetas, then
    // threw all but the count away. It shares its cache entry with the sidebar
    // widgets, so a cold /archives render drops ~8 round trips to Neon.
    [settings, index, { posts: total }, items] = await Promise.all([
      getSettings(),
      archiveGroups(),
      counts(),
      archiveItems({
        year: year || undefined,
        month: month && month >= 1 && month <= 12 ? month : undefined,
        limit: ARCH_PER_PAGE,
        offset: (page - 1) * ARCH_PER_PAGE,
      }),
    ]);
    kvSet(archKey, { settings, index, total, items }, 300);
  }
  const filtered = !!(year || month);
  // The size of the window being paged: the filtered set, or everything.
  const windowTotal = filtered
    ? (year && month ? index.find((y) => y.year === year)?.months.find((m) => m.month === month)?.count : undefined) ??
      index.find((y) => y.year === year)?.total ?? 0
    : total;
  const totalPages = Math.max(1, Math.ceil(windowTotal / ARCH_PER_PAGE));
  if (page > totalPages) return { notFound: true };
  // R233: R232's "showing the newest 1000 only" notice is gone - the window is
  // a real page now, so the older posts sit on a page instead of nowhere. The
  // pager keeps ?year=/?month=, so paging never drops the reader's filter.
  const archBase = canonicalPath("/archives", archLocale) +
    (filtered ? `?${year ? `year=${year}` : ""}${month ? `${year ? "&" : ""}month=${month}` : ""}` : "");
  const archPager = R.pager(page, totalPages, (n) => {
    if (n <= 1) return archBase;
    return `${archBase}${archBase.includes("?") ? "&" : "?"}page=${n}`;
  }, t);

  const buckets = new Map<string, typeof items>();
  for (const e of items) {
    const d = e.publishedAt ? new Date(e.publishedAt) : null;
    // Sentinel key: a real bucket key is always "YYYY-M", so this can never
    // collide with one.
    const key = d ? `${d.getFullYear()}-${d.getMonth() + 1}` : "__unpublished__";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(e);
  }

  const sectionLabel = (key: string): string =>
    key === "__unpublished__"
      ? t("archives.unpublished")
      : t("archives.ym", { y: key.slice(0, 4), m: Number(key.slice(5)) });

  const sections = [...buckets.entries()]
    .map(([key, list]) => {
      const lis = list
        .map((p) => {
          const fmt = postFormatLabel(p.format, t);
          const badge =
            fmt && p.format !== "standard"
              ? `<span class="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style="background:var(--accent-soft);color:var(--accent)">${esc(fmt)}</span>`
              : "";
          return (
            `<li><a class="group flex items-baseline gap-3 rounded-md px-2 py-1.5 transition" style="color:var(--text)" href="${esc(localeHref(p.url, archLocale))}">` +
            `<span class="w-20 shrink-0 font-mono text-xs tabular-nums" style="color:var(--muted)">${esc(R.formatSiteDate(p.publishedAt, settings as any))}</span>` +
            `<span class="flex-1 group-hover:underline">${esc(p.title)}</span>${badge}` +
            `<span class="hidden shrink-0 items-center gap-1 text-[11px] sm:flex" style="color:var(--muted)">${EYE_SVG} ${esc(p.views)}</span>` +
            `</a></li>`
          );
        })
        .join("");
      const label = sectionLabel(key);
      return (
        `<section><h2 class="mb-3 border-b pb-1.5 text-sm font-semibold" style="border-color:var(--border);color:var(--muted)">` +
        `${esc(label)}<span class="ml-2 text-xs opacity-60">${esc(t("archives.n_posts", { n: list.length }))}</span></h2>` +
        `<ul class="space-y-1">${lis}</ul></section>`
      );
    })
    .join("");

  const filterHint = filtered
    ? ` · ${t("archives.filter")} ${year ? t("archives.y", { y: year }) : t("archives.all")}` +
      `${month ? ` ${t("archives.month", { m: month })}` : ""}` +
      ` · <a href="${esc(localeHref("/archives", archLocale))}" class="underline" style="color:var(--link)">${t("archives.clear")}</a>`
    : "";

  const aside =
    `<aside class="space-y-4 lg:sticky lg:top-24 lg:self-start">` +
    index
      .map((y) => {
        const yColor = year === y.year ? "var(--accent)" : "var(--text)";
        const months = y.months
          .map((m) => {
            const mColor = year === y.year && month === m.month ? "var(--accent)" : "var(--muted)";
            return (
              // R233: the sidebar links were hard-coded to the zh path, so a
              // click under /en dropped the reader into the Chinese tree with
              // no way back. localeHref is what the rest of the chrome uses.
              `<li><a href="${esc(localeHref(`/archives?year=${y.year}&month=${m.month}`, archLocale))}" class="flex items-center justify-between text-xs transition hover:underline" style="color:${mColor}">` +
              `${esc(t("archives.month", { m: m.month }))}<span class="opacity-60">${m.count}</span></a></li>`
            );
          })
          .join("");
        return (
          `<div><a href="${esc(localeHref(`/archives?year=${y.year}`, archLocale))}" class="flex items-center justify-between text-sm font-semibold transition hover:underline" style="color:${yColor}">` +
          `${y.year}<span class="text-xs font-normal" style="color:var(--muted)">${y.total}</span></a>` +
          `<ul class="mt-1 space-y-0.5 pl-3">${months}</ul></div>`
        );
      })
      .join("") +
    `</aside>`;

  const main =
    `<div class="grid gap-8 lg:grid-cols-[1fr_240px]"><div>` +
    `<header class="mb-8">` +
    `<h1 class="flex items-center gap-2 text-3xl font-bold text-[var(--text)]">${CALENDAR_DAYS_SVG}${t("crumb.archive")}</h1>` +
    // R231: `total` is the site-wide published count, which is what the bare
    // archive means. On a ?year=/?month= view it is the wrong number - the
    // header read "20 posts" beside its own empty-state box for a year with
    // none (the window is filtered, the total never was). R233: the count is
    // the WINDOW's size, so it stays right across pages.
    `<p class="mt-2 text-sm" style="color:var(--muted)">${t("archives.count", { n: `<span style="color:var(--accent)">${filtered ? windowTotal : total}</span>` })}${filterHint}</p>` +
    `</header>` +
    (items.length
      ? `<div class="space-y-8">${sections}</div>${archPager}`
      : `<p class="rounded-2xl border p-10 text-center text-sm" style="border-color:var(--border);background:var(--surface);color:var(--muted)">${t("archives.empty")}</p>`) +
    `</div>${aside}</div>`;

  const siteTitle = settings.siteTitle ?? "";
  const archDesc = t("archives.desc", { site: siteTitle });

  // R233: the window is a real page now, so ?page=N>1 joins the canonical too -
  // a paged archive is its own URL, not a duplicate of page 1.
  const archCanonical = `${ctx?.origin ?? ""}${
    page > 1
      ? `${archBase}${archBase.includes("?") ? "&" : "?"}page=${page}`
      : archBase
  }`;
  const archOgImage = esc(R.socialImage(settings.logoUrl, ctx?.origin ?? "", settings.ogImageUrl));
  const head =
    `<link rel="canonical" href="${esc(archCanonical)}">` +
    `<meta name="description" content="${esc(archDesc)}">` +
    `<meta name="robots" content="${filtered ? "noindex, follow" : R.robotsFor(settings.seoRobots)}">` +
    `<meta property="og:title" content="${esc(t("crumb.archive"))} - ${esc(siteTitle)}">` +
    `<meta property="og:description" content="${esc(archDesc)}">` +
    `<meta property="og:url" content="${esc(archCanonical)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="${esc(siteTitle)}">` +
    (archOgImage ? `<meta property="og:image" content="${archOgImage}">` : "") +
    `<meta name="twitter:card" content="${R.twitterCardKind(settings.twitterCard, archOgImage)}">` +
    `<meta name="twitter:title" content="${esc(t("crumb.archive"))} - ${esc(siteTitle)}">` +
    `<meta name="twitter:description" content="${esc(archDesc)}">` +
    (archOgImage ? `<meta name="twitter:image" content="${archOgImage}">` : "") +
    R.collectionJsonLd({
      url: archCanonical,
      title: `${t("crumb.archive")} - ${siteTitle}`,
      description: archDesc,
      inLanguage: archLocale,
      items: items.map((p) => ({ title: p.title, url: `${ctx?.origin ?? ""}${p.url}` })),
    }) +
    R.breadcrumbListJsonLd([
      { name: t("crumb.home"), url: `${ctx?.origin ?? ""}${canonicalPath("/", localeOf(ctx))}` },
      { name: t("crumb.archive"), url: archCanonical },
    ]);
  return {

    headTitle: `${t("crumb.archive")} - ${siteTitle}`,
    head,
    main,
  };
}

/**
 * Original SearchPage behavior: a non-?all search with exactly one hit
 * redirects straight to that post. Used by the middleware (302), never by
 * the page itself, which can only render.
 */
export async function searchRedirect(q: string): Promise<string | null> {
  return searchSingleHit(q);
}

// ----------------------------------------------------- sitemap / feed / robots

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * R144: conditional GET for the XML documents (feed/sitemap) - a cold feed
 * once reached the wire with NO validator, so a reader could never
 * revalidate without re-downloading the whole body. R241: minting the tag and
 * answering If-None-Match both go through the framework's validator helpers
 * (contentEtag/ifNoneMatch, now owned by ./etag.ts - the same pair
 * responseEtag uses at every framework exit), replacing the app's private copy
 * of the sha1 dialect so the two cannot drift; comparison is now RFC 9110
 * 13.1.2 (tag lists, `*`, weak equivalence) instead of string equality. The
 * framework's non-HTML validator branch (BUG.md AM) re-checks this same
 * response as a backstop - this layer answers directly so a match does not
 * wait for the whole body to be buffered. The 304 carries the same headers a
 * 200 would have (RFC 9110 15.4.5), and only a GET is answered bodiless.
 */
export function xmlResponse(body: string, request: Request, headers: Record<string, string>): Response {
  // R207: XML docs (feeds + sitemaps) carry author-controlled text (post
  // titles, author names) as application/xml — without nosniff a browser may
  // re-sniff the bytes as HTML and run inline script. The three static
  // byte-paths and HTML pages already set it; XML is the one gap Oboext owns.
  const etag = contentEtag(Buffer.from(body));
  const out = { ...headers, etag, "x-content-type-options": "nosniff" };
  if (request.method === "GET" && ifNoneMatch(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: out });
  }
  return new Response(body, { status: 200, headers: out });
}

/**
 * The RSS feed for a locale. The channel identity (title/description) is site
 * data and stays as configured; what changes per locale is the <language>, the
 * channel link and every item link — an English subscriber must not receive
 * links back into the zh tree.
 */
// R150: the document body is pure in (origin, locale, rows) - memoized 30s so
// the hot cache's background refresh (every ~10s under traffic) and every
// alias/locale path stop re-running the queries; invalidateContentCaches
// drops `doc:` at each content write, so freshness is invalidation-driven
// exactly like the R149 session memo. Strings are immutable, so the memoized
// value needs no clone.
async function feed(ctx: Ctx, locale: Locale = "zh-CN"): Promise<string> {
  return memoQuery(`doc:feed:${ctx.origin}:${locale}`, 30_000, () => buildFeed(ctx, locale));
}

async function buildFeed(ctx: Ctx, locale: Locale = "zh-CN"): Promise<string> {
  const en = locale === "en";
  const settings = await getSettings();
  const feedItems = Math.min(Math.max(Number(settings.feedItems) || 20, 1), 100);
  // feedContent=full ships the body: listPosts strips content by default, so
  // the flag must reach the query, not just the renderer below. It also drives
  // <description> (plain-text body instead of the excerpt) — one switch in the
  // settings UI, one behavior. (An earlier draft added a separate
  // feed_full_text option here, but the settings schema already ships
  // feedContent=excerpt|full — two disconnected switches for the same intent,
  // and the visible one could not turn on the description branch. Folded.)
  const full = settings.feedContent === "full";
  const [{ items }, { items: pageItems }] = await Promise.all([
    listPosts({ status: "published", limit: feedItems, pinned: false, full }),
    listPublishedPages({ limit: feedItems }),
  ]);
  // R144: a validator-backed document must be BYTE-STABLE. The old pubDate
  // fallback (`?? new Date()`) stamped the wall clock into any item without
  // publishedAt, so two renders of identical content hashed differently and a
  // matching If-None-Match could never arrive. Published items always carry
  // publishedAt; an item without one now carries no pubDate (RSS 2.0 makes it
  // optional), and lastBuildDate below is DERIVED from the items - never now.
  let newest = 0;
  for (const p of [...items, ...pageItems]) {
    const t = p.publishedAt ? new Date(p.publishedAt).getTime() : NaN;
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  const lastBuildDate = newest
    ? `\n    <lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>`
    : "";
  const cdata = (html: string) =>
    `<![CDATA[${html.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
  const xmlItems = (
    await Promise.all(
      [...items, ...pageItems].map(async (p) => {
        const kind = "author" in p ? "post" : "page";
        const extra = full
          ? `\n      <content:encoded>${cdata(await R.buildPostBody(p, kind))}</content:encoded>`
          : "";
        // real categories: the post's own tags (pages have none); "author" in
        // p is the discriminated check - PostView has it, PageView does not
        const cats = "author" in p && p.tags?.length
          ? p.tags.map((t) => `\n      <category>${escXml(t.name)}</category>`).join("")
          : "";
        // Item links are locale-aware: the en feed points at /en pages, so an
        // English subscriber never gets links back into the zh tree.
        const itemUrl = `${escXml(ctx.origin)}${escXml(localeHref(p.url, locale))}`;
        const media = p.featuredImage ? `\n      ${R.mediaImageTag(p.featuredImage, ctx.origin)}` : "";
        // dc:creator carries the author's display name (RSS 2.0 / Dublin Core).
        // Posts have an author; pages don't. Name only - a real address is not
        // ours to publish, and the noreply@<domain> fake is a spam magnet.
        const authorName = kind === "post" ? (p as { author?: { name?: string } | null }).author?.name : "";
        const creator = authorName ? `\n      <dc:creator>${escXml(authorName)}</dc:creator>` : "";
        // No wall-clock fallback (see the byte-stability note above): an item
        // without publishedAt simply ships no pubDate.
        const pub = p.publishedAt
          ? `\n      <pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate>`
          : "";
        return (
          `    <item>\n      <title>${escXml(p.title)}</title>\n      <link>${itemUrl}</link>` +
          `\n      <guid>${itemUrl}</guid>${pub}` +
          `\n      <description>${escXml(
            full
              ? R.blocksToPlainText((p as { content?: Parameters<typeof R.blocksToPlainText>[0] }).content) || p.excerpt || ""
              : p.excerpt ?? "",
          )}</description>${creator}${media}${cats}${extra}\n    </item>`
        );
      }),
    )
  ).join("\n");
  // R144: atom:link rel=self names the CANONICAL feed URL for the locale
  // (/feed.xml, /en/feed.xml) - validators and reader auto-discovery require
  // the channel to identify itself, and the three aliases (/rss.xml, /feed,
  // /api/feed) must all claim the same canonical self, not their own alias.
  const selfUrl = `${escXml(ctx.origin)}${escXml(localeHref("/feed.xml", locale))}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml(settings.siteTitle ?? "")}</title>
    <link>${escXml(ctx.origin)}${escXml(localeHref("/", locale))}</link>
    <description>${escXml(settings.siteDescription ?? "")}</description>
    <language>${en ? "en" : "zh-CN"}</language>
    <atom:link rel="self" type="application/rss+xml" href="${selfUrl}"/>${lastBuildDate}
${xmlItems}
  </channel>
</rss>`;
}

/**
 * JSON Feed 1.1 (https://jsonfeed.org/version/1.1) for a locale - the third
 * subscription format beside RSS 2.0, read natively by Feedly, NetNewsWire,
 * NewsBlur and every modern reader that prefers JSON over XML. Shares the
 * feed()'s query contract (item cap, feedContent=full) and the R144
 * byte-stability discipline: date_published is DERIVED from publishedAt and
 * simply absent when unknown - never the wall clock - so this body is
 * validator-safe under xmlResponse() too. Locale rules mirror feed(): the
 * English feed's home/feed/item URLs all live under /en, the channel title
 * stays site data.
 */
// R150: same memo contract as feed() (see buildFeed): origin+locale keyed,
// dropped by invalidateContentCaches at every content write.
async function jsonFeed(ctx: Ctx, locale: Locale = "zh-CN"): Promise<string> {
  return memoQuery(`doc:jsonFeed:${ctx.origin}:${locale}`, 30_000, () => buildJsonFeed(ctx, locale));
}

async function buildJsonFeed(ctx: Ctx, locale: Locale = "zh-CN"): Promise<string> {
  const en = locale === "en";
  const settings = await getSettings();
  const feedItems = Math.min(Math.max(Number(settings.feedItems) || 20, 1), 100);
  const full = settings.feedContent === "full";
  const [{ items }, { items: pageItems }] = await Promise.all([
    listPosts({ status: "published", limit: feedItems, pinned: false, full }),
    listPublishedPages({ limit: feedItems }),
  ]);
  const abs = (u: string) => (u.startsWith("/") ? `${ctx.origin}${u}` : u);
  const feedEntries = await Promise.all(
    [...items, ...pageItems].map(async (p) => {
      const kind = "author" in p ? "post" : "page";
      const url = `${ctx.origin}${localeHref(p.url, locale)}`;
      const entry: Record<string, unknown> = { id: url, url, title: p.title };
      // The spec requires content_html OR content_text per item: full mode
      // ships the built body, the default ships the excerpt as text.
      if (full) entry.content_html = await R.buildPostBody(p, kind);
      else entry.content_text = p.excerpt ?? "";
      if (p.excerpt) entry.summary = p.excerpt;
      if (p.publishedAt) entry.date_published = new Date(p.publishedAt).toISOString();
      if (p.featuredImage) entry.image = abs(String(p.featuredImage));
      const authorName = kind === "post" ? (p as { author?: { name?: string } | null }).author?.name : "";
      if (authorName) entry.authors = [{ name: authorName }];
      if ("author" in p && p.tags?.length) entry.tags = p.tags.map((t) => t.name);
      return entry;
    }),
  );
  return JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: settings.siteTitle ?? "",
      home_page_url: `${ctx.origin}${localeHref("/", locale)}`,
      feed_url: `${ctx.origin}${localeHref("/feed.json", locale)}`,
      description: settings.siteDescription ?? "",
      language: en ? "en" : "zh-CN",
      items: feedEntries,
    },
    null,
    2,
  );
}

/**
 * R147: the site-wide comments feed (RSS 2.0) - the syndication suite's third
 * surface beside the posts feed and the JSON Feed: subscribers follow the
 * conversation without polling post pages. Same contracts as feed():
 * locale-aware links (/en/comments/feed.xml points into the /en tree), the
 * atom self names the canonical URL, byte-stable body (pubDate from
 * createdAt, lastBuildDate DERIVED from the rows - never now) so
 * xmlResponse()'s validator answers, and description carries the comment as
 * escaped PLAIN TEXT: comment bodies are user input and must never enter the
 * feed as markup. Moderation lives in the query (listCommentFeed): only
 * approved comments on published posts are reachable here.
 */
// R150: same memo contract as feed() (see buildFeed) - the comments feed's
// join query now runs once per window, not once per poll/refresh.
async function commentsFeed(ctx: Ctx, locale: Locale = "zh-CN"): Promise<string> {
  return memoQuery(`doc:commentsFeed:${ctx.origin}:${locale}`, 30_000, () => buildCommentsFeed(ctx, locale));
}

async function buildCommentsFeed(ctx: Ctx, locale: Locale = "zh-CN"): Promise<string> {
  const en = locale === "en";
  const t = makeT(locale);
  const settings = await getSettings();
  const feedItems = Math.min(Math.max(Number(settings.feedItems) || 20, 1), 100);
  const rows = await listCommentFeed(feedItems);
  let newest = 0;
  for (const r of rows) {
    const d = new Date(r.createdAt).getTime();
    if (Number.isFinite(d) && d > newest) newest = d;
  }
  const lastBuildDate = newest
    ? `\n    <lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>`
    : "";
  const items = rows
    .map((r) => {
      const itemUrl =
        `${escXml(ctx.origin)}${escXml(localeHref(r.post.url, locale))}#comment-item-${r.id}`;
      return (
        `    <item>\n      <title>${escXml(r.post.title)} — ${escXml(r.authorName)}</title>` +
        `\n      <link>${itemUrl}</link>\n      <guid isPermaLink="true">${itemUrl}</guid>` +
        `\n      <pubDate>${new Date(r.createdAt).toUTCString()}</pubDate>` +
        `\n      <description>${escXml(r.content)}</description>` +
        `\n      <dc:creator>${escXml(r.authorName)}</dc:creator>\n    </item>`
      );
    })
    .join("\n");
  const selfUrl = `${escXml(ctx.origin)}${escXml(localeHref("/comments/feed.xml", locale))}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml(t("feed.comments_title", { site: settings.siteTitle ?? "" }))}</title>
    <link>${escXml(ctx.origin)}${escXml(localeHref("/", locale))}</link>
    <description>${escXml(settings.siteDescription ?? "")}</description>
    <language>${en ? "en" : "zh-CN"}</language>
    <atom:link rel="self" type="application/rss+xml" href="${selfUrl}"/>${lastBuildDate}
${items}
  </channel>
</rss>`;
}

/**
 * R155: the JSON Feed 1.1 twin of commentsFeed - the subscription matrix's
 * last empty cell (posts RSS / posts JSON / comments RSS / comments JSON).
 * Same rows, same moderation (listCommentFeed's join is the only gate), same
 * locale contract, and content_text ONLY: comment bodies are user input, and
 * JSON Feed's content_html would be handed to a reader's HTML renderer -
 * content_text is the field that promises "not markup".
 */
// R150/R155: memoized like the other three documents (doc: prefix, dropped by
// invalidateContentCaches at every content write).
async function commentsJsonFeed(ctx: Ctx, locale: Locale = "zh-CN"): Promise<string> {
  return memoQuery(`doc:commentsJsonFeed:${ctx.origin}:${locale}`, 30_000, () =>
    buildCommentsJsonFeed(ctx, locale),
  );
}

async function buildCommentsJsonFeed(ctx: Ctx, locale: Locale = "zh-CN"): Promise<string> {
  const en = locale === "en";
  const t = makeT(locale);
  const settings = await getSettings();
  const feedItems = Math.min(Math.max(Number(settings.feedItems) || 20, 1), 100);
  const rows = await listCommentFeed(feedItems);
  const items = rows.map((r) => {
    const itemUrl =
      `${ctx.origin}${localeHref(r.post.url, locale)}#comment-item-${r.id}`;
    const entry: Record<string, unknown> = {
      id: itemUrl,
      url: itemUrl,
      title: `${r.post.title} — ${r.authorName}`,
      content_text: r.content,
      date_published: new Date(r.createdAt).toISOString(),
      authors: [{ name: r.authorName }],
    };
    // JSON Feed 1.1 extension point: readers ignore unknown _custom fields,
    // but a client that wants to group by thread can - and the spec explicitly
    // reserves the underscore prefix for this.
    entry._custom = { post_title: r.post.title, post_url: `${ctx.origin}${localeHref(r.post.url, locale)}` };
    return entry;
  });
  return JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: t("feed.comments_title", { site: settings.siteTitle ?? "" }),
      home_page_url: `${ctx.origin}${localeHref("/", locale)}`,
      feed_url: `${ctx.origin}${localeHref("/comments/feed.json", locale)}`,
      description: settings.siteDescription ?? "",
      language: en ? "en" : "zh-CN",
      items,
    },
    null,
    2,
  );
}

/**
 * R160: per-category / per-tag feeds. The subscription matrix was site-wide
 * only (posts, comments, JSON twins) - a reader who follows one topic had to
 * take the whole blog. The path is resolved against the CONFIGURED category/
 * tag bases (custom permalinks keep working), so this branch is base-agnostic;
 * an unknown path returns null and falls through to normal 404 routing rather
 * than claiming every path that happens to end in feed.xml.
 *
 * R162: the resolution half is shared with the JSON twin below. Both documents
 * must own exactly the same paths and window the same posts; one resolver is
 * what makes them twins instead of look-alikes that drift.
 *
 * R182: an author archive is the third term listing, and it was the only one
 * without a subscription - the middleware already funnels every
 * `<base>/feed.{xml,json}` here, so claiming `/author/<id>` inside this
 * resolver gives the author feeds both twins and the same window, discovery
 * and validator rules as a category, with no second routing branch to drift.
 * The path is matched against the fixed `/author/<numeric id>` shape (links.ts
 * keeps it deliberately non-configurable), and an author with no published
 * post owns nothing here either: the archive page itself 404s an empty
 * listing, so a feed that would list nothing falls through to the same 404
 * instead of subscribing a reader to a document that contradicts its page.
 */
const AUTHOR_FEED_PATH = new RegExp(`^/${AUTHOR_BASE_SEGMENT}/(\\d{1,9})$`);

async function resolveTaxonomyDoc(basePath: string) {
  const want = basePath.replace(/\/+$/, "");
  const settings = await getSettings();
  const feedItems = Math.min(Math.max(Number(settings.feedItems) || 20, 1), 100);
  const full = settings.feedContent === "full";
  const authorId = AUTHOR_FEED_PATH.exec(want)?.[1];
  if (authorId) {
    const author = await getPublicAuthor(Number(authorId));
    if (!author) return null;
    const { items } = await listPosts({
      status: "published",
      authorId: author.id,
      limit: feedItems,
      pinned: false,
      full,
    });
    if (!items.length) return null;
    return {
      cat: undefined, tag: undefined, want, settings, items, full,
      name: author.name,
      description: (author.bio ?? "").trim(),
    };
  }
  const [cfg, cats, tags] = await Promise.all([
    getPermalinkConfig(),
    listCategories(),
    listTags(),
  ]);
  const cat = cats.find((c) => categoryUrlFor(cfg, c) === want);
  const tag = cat ? undefined : tags.find((tt) => tagUrlFor(cfg, tt) === want);
  if (!cat && !tag) return null;
  const { items } = await listPosts({
    status: "published",
    ...(cat ? { categorySlug: cat.slug } : { tagSlug: tag!.slug }),
    limit: feedItems,
    pinned: false,
    full,
  });
  return {
    cat, tag, want, settings, items, full,
    name: cat ? cat.name : tag!.name,
    description: cat?.description ?? "",
  };
}

async function taxonomyFeed(ctx: Ctx, locale: Locale, basePath: string): Promise<string | null> {
  return memoQuery(`doc:taxfeed:${ctx.origin}:${locale}:${basePath}`, 30_000, () =>
    buildTaxonomyFeed(ctx, locale, basePath),
  );
}

async function buildTaxonomyFeed(
  ctx: Ctx,
  locale: Locale,
  basePath: string,
): Promise<string | null> {
  const doc = await resolveTaxonomyDoc(basePath);
  if (!doc) return null;
  const en = locale === "en";
  const t = makeT(locale);
  const itemXml = await Promise.all(
    doc.items.map(async (p) => {
      const link = `${escXml(ctx.origin)}${escXml(localeHref(p.url, locale))}`;
      // R144 discipline: no wall clock - an item without a publication date
      // simply omits the optional element, so the body stays byte-stable.
      const body = doc.full ? await R.buildPostBody(p, "post") : escXml(p.excerpt ?? "");
      return (
        `    <item>\n      <title>${escXml(p.title)}</title>` +
        `\n      <link>${link}</link>\n      <guid isPermaLink="true">${link}</guid>` +
        (p.publishedAt ? `\n      <pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate>` : "") +
        `\n      <description>${body}</description>\n    </item>`
      );
    }),
  );
  const selfUrl = `${escXml(ctx.origin)}${escXml(localeHref(`${doc.want}/feed.xml`, locale))}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml(t("feed.taxonomy_title", { site: doc.settings.siteTitle ?? "", name: doc.name }))}</title>
    <link>${escXml(ctx.origin)}${escXml(localeHref(doc.want, locale))}</link>
    <description>${escXml(doc.description || doc.settings.siteDescription || "")}</description>
    <language>${en ? "en" : "zh-CN"}</language>
    <atom:link rel="self" type="application/rss+xml" href="${selfUrl}"/>
${itemXml.join("\n")}
  </channel>
</rss>`;
}

/**
 * R162: the JSON Feed 1.1 twin of a taxonomy feed - the subscription matrix's
 * last two cells (category/tag x JSON). Same resolver, same window, same
 * locale prefix contract (every URL rides canonicalPath), and the item field
 * set mirrors the site-wide JSON Feed so a reader sees one shape everywhere.
 */
async function taxonomyJsonFeed(ctx: Ctx, locale: Locale, basePath: string): Promise<string | null> {
  return memoQuery(`doc:taxjson:${ctx.origin}:${locale}:${basePath}`, 30_000, () =>
    buildTaxonomyJsonFeed(ctx, locale, basePath),
  );
}

async function buildTaxonomyJsonFeed(
  ctx: Ctx,
  locale: Locale,
  basePath: string,
): Promise<string | null> {
  const doc = await resolveTaxonomyDoc(basePath);
  if (!doc) return null;
  const en = locale === "en";
  const t = makeT(locale);
  const abs = (u: string) => (u.startsWith("/") ? `${ctx.origin}${u}` : u);
  const items = await Promise.all(
    doc.items.map(async (p) => {
      const url = `${ctx.origin}${localeHref(p.url, locale)}`;
      const entry: Record<string, unknown> = { id: url, url, title: p.title };
      // Spec requires content_html OR content_text per item - same split as
      // the site-wide JSON Feed (feedContent=full ships the built body).
      if (doc.full) entry.content_html = await R.buildPostBody(p, "post");
      else entry.content_text = p.excerpt ?? "";
      if (p.excerpt) entry.summary = p.excerpt;
      if (p.publishedAt) entry.date_published = new Date(p.publishedAt).toISOString();
      if (p.featuredImage) entry.image = abs(String(p.featuredImage));
      if (p.author?.name) entry.authors = [{ name: p.author.name }];
      if (p.tags?.length) entry.tags = p.tags.map((tt) => tt.name);
      return entry;
    }),
  );
  return JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: t("feed.taxonomy_title", { site: doc.settings.siteTitle ?? "", name: doc.name }),
      home_page_url: `${ctx.origin}${localeHref(doc.want, locale)}`,
      feed_url: `${ctx.origin}${localeHref(`${doc.want}/feed.json`, locale)}`,
      description: doc.description || doc.settings.siteDescription || "",
      language: en ? "en" : "zh-CN",
      items,
    },
    null,
    2,
  );
}

async function robots(ctx: Ctx): Promise<string> {
  // Single source of truth lives in sitemap.ts (buildRobotsTxt); this used to
  // be a second copy of the same rules, which drifted the moment one changed.
  return buildRobotsTxt(ctx.origin);
}

function guessImageType(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  switch (ext) {
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "ico": return "image/x-icon";
    default: return "";
  }
}

async function manifest(_ctx: Ctx): Promise<string> {
  const [settings, renderConfig] = await Promise.all([
    getSettings(),
    getActiveThemeRenderConfig(),
  ]);
  const accent = resolveThemeConfig(renderConfig).accent;
  const icons: Array<{ src: string; sizes: string; type?: string }> = [];
  for (const src of [settings.faviconUrl, settings.logoUrl]) {
    if (!src || icons.some((i) => i.src === src)) continue;
    const icon: { src: string; sizes: string; type?: string } = { src, sizes: "any" };
    const type = guessImageType(String(src));
    if (type) icon.type = type;
    icons.push(icon);
  }
  return JSON.stringify({
    name: settings.siteTitle || "Oboext",
    short_name: (settings.siteTitle || "Oboext").slice(0, 12),
    description: settings.tagline || settings.siteDescription || "",
    start_url: "/",
    scope: "/",
    display: "standalone",
    lang: settings.language || "zh-CN",
    background_color: "#ffffff",
    theme_color: accent,
    icons,
  });
}

async function notFound(_p: unknown, _ctx: Ctx) {
  // The recent-posts fetch rides the same parallel wave as the settings reads:
  // it only costs an extra query when showRecent is off (the result is simply
  // dropped), while awaiting it behind the settings reads cost one serial
  // round trip on every 404.
  const locale = localeOf(_ctx);
  const t = makeT(locale);
  const [settings, site, themeSlug, recentResult] = await Promise.all([
    getNotFoundSettings(),
    getSettings(),
    getActiveThemeSlug(),
    listPosts({ status: "published", limit: 6 }),
  ]);
  // The 404 body is a THEME capability: a theme that ships a designed
  // not-found page mirrors it as chrome.notFoundPage. The program asks for the
  // capability, not for a theme name.
  const chromeForNotFound = getThemeChrome(themeSlug);
  const themed = typeof chromeForNotFound.notFoundPage === "function";
  let recent: Array<{ url: string; title: string }> = [];
  if (settings.showRecent) {
    recent = (recentResult.items || [])
      .slice(0, themed ? 5 : 6)
      .map((p: PostView) => ({ url: localeHref(p.url, locale), title: p.title }));
  }
  return {
    settings,
    recent,
    siteTitle: site.siteTitle ?? "",
    themeSlug,
    skin:
      themed && chromeForNotFound.notFoundPage
        ? chromeForNotFound.notFoundPage({ settings, recent, t, homeHref: localeHref("/", locale) })
        : "",
    locale,
    htmlLang: htmlLangOf(locale),
    // 返回首页 keeps the visitor in the locale they asked for.
    homeHref: localeHref("/", locale),
    searchAction: localeHref("/search", locale),
    strings: {
      title: t("notfound.title"),
      searchPlaceholder: t("notfound.search_placeholder"),
      searchLabel: t("notfound.search_label"),
      searchSubmit: t("notfound.search_submit"),
      backHome: t("notfound.back_home"),
      recent: t("notfound.recent"),
    },
  };
}

// ---------------------------------------------------- root catch-all resolver

function virtualRouteView(route: VirtualSiteRoute, ctx: Ctx) {
  const title = route.seoTitle || route.title;
  const desc = route.seoDescription ?? "";
  const kw = route.seoKeywords ?? "";
  const canonical = `${ctx.origin ?? ""}${canonicalPath(route.path, localeOf(ctx))}`;
  const head =
    `<title>${R.esc(title)}</title>` +
    (desc ? `<meta name="description" content="${R.esc(desc)}">` : "") +
    (kw ? `<meta name="keywords" content="${R.esc(kw)}">` : "") +
    `<link rel="canonical" href="${R.esc(canonical)}">` +
    `<meta name="robots" content="${R.robotsFor(settings.seoRobots)}">` +
    `<meta property="og:title" content="${R.esc(title)}">` +
    (desc ? `<meta property="og:description" content="${R.esc(desc)}">` : "") +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${R.esc(canonical)}">`;
  const main =
    `<div class="container-np" style="padding:40px 16px 64px;max-width:1200px;margin-inline:auto">` +
    `<h1 style="font-size:28px;font-weight:700;margin-bottom:8px;color:var(--text-color,var(--foreground,#18181b))">${R.esc(route.title)}</h1>` +
    `<div>${route.html}</div>` +
    `</div>`;
  return { head, main };
}

function userCenterView(route: VirtualSiteRoute, ctx: Ctx) {
  const title = route.seoTitle || route.title;
  const canonical = `${ctx.origin ?? ""}${canonicalPath(route.path, localeOf(ctx))}`;
  const head =
    `<title>${R.esc(title)}</title>` +
    `<meta name="robots" content="noindex, nofollow">` +
    `<link rel="canonical" href="${R.esc(canonical)}">`;
  const main =
    `<div class="container-np" style="padding:40px 16px 64px;max-width:1200px;margin-inline:auto">` +
    `<div>${route.html}</div>` +
    `</div>`;
  return { head, main };
}

function maintenanceView(settings: MaintenanceSettings) {
  const paras = String(settings.message || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => `<p>${R.esc(p)}</p>`)
    .join("");
  const main =
    `<div class="container-np" style="display:flex;align-items:center;justify-content:center;min-height:60vh;padding:64px 16px;">` +
    `<div style="width:100%;max-width:520px;border:1px solid var(--border-color,var(--border,#e5e7eb));border-radius:16px;background:var(--surface-color,var(--surface,#fff));padding:44px 36px;text-align:center;">` +
    `<h1 style="font-size:24px;font-weight:700;color:var(--text-color,var(--foreground,#18181b));">${R.esc(settings.title)}</h1>` +
    `<div style="margin-top:12px;font-size:14px;line-height:1.7;color:var(--text-color-2,#52525b);">${paras}</div>` +
    `</div></div>`;
  return main;
}

/** How long a confirmed path miss suppresses re-probing. The write and the
 *  read below must agree, so it lives here rather than as two literals. */
const PATH_MISS_TTL = 60_000;

/**
 * Catch-all exit post-processing, applied once so every view kind gets it:
 * hreflang alternates in the head (canonical stays the bare default-locale
 * path) and the locale prefix on root-relative links in the main HTML, which
 * keeps navigation inside /en. The default locale is a no-op on both.
 */
/**
 * R275: the per-post hreflang cluster. The counterpart URL comes from
 * translationPair (resolveInner resolved it through the REAL permalink config,
 * so id/pinyin/date modes all land on a reachable URL). Both directions are
 * emitted from BOTH pages of the pair — the confirm-back rule needs each URL
 * to advertise the other, and each page here knows only its own half, so the
 * cluster always carries both locales with this page's own locale href being
 * the path being rendered.
 */
function hreflangPairLinks(origin: string, path: string, locale: Locale, pair: { url: string }): string {
  if (!isPairingActive()) return hreflangLinks(origin, path);
  const other = otherLocale(locale);
  const base = `${origin || ""}${path}`;
  const otherUrl = `${origin || ""}${pair.url}`;
  return (
    `<link name="hreflang-${locale}" rel="alternate" hreflang="${locale}" href="${base}">` +
    `<link name="hreflang-${other}" rel="alternate" hreflang="${other}" href="${otherUrl}">` +
    `<link name="hreflang-x-default" rel="alternate" hreflang="x-default" href="${base}">`
  );
}

function finalizeView(view: Record<string, any> | null, ctx: Ctx, locale: Locale) {
  if (!view || typeof view !== "object") return view;
  if (!ctx) return view;
  const path = (ctx && ctx.pathname) || "/";
  const head = typeof view.head === "string" ? view.head : "";
  const main = typeof view.main === "string" ? view.main : "";
  // R275: per-page pairing. The site-level flag (R274) turns the whole tree
  // self-canonical; THIS cluster is still only emitted when the post being
  // rendered actually has a counterpart — an untranslated /en page carries no
  // fake alternates even on a paired site. The pair URL rides canonicalPath
  // (self-referencing in pairing mode, merged otherwise) so both ends always
  // describe reachable URLs.
  const pair = (view as { translationPair?: { url: string; selfLocale: string } }).translationPair;
  const cluster = pair
    ? hreflangPairLinks(ctx.origin || "", path, locale, pair)
    : hreflangLinks(ctx.origin || "", path);
  return {
    ...view,
    head: head + cluster,
    main: prefixLocaleUrls(main, locale),
  };
}

async function resolveInner(payload: { segments?: string[]; page?: number }, ctx: Ctx) {
  if (process.env.OBOEXT_DEBUG_RESOLVE) {
    const sm = (globalThis as any).__rosezm_signalMap as Map<string, unknown> | undefined;
    log.debug("[resolve-debug] payload:", JSON.stringify(payload), "pathname:", ctx?.pathname,
      "signalMap.slug:", JSON.stringify((sm as any)?.get?.("slug")?.() ?? (sm as any)?.get?.("slug")),
      "mapSize:", sm?.size);
  }
  const raw = (payload.segments ?? []).map((s) => String(s));
  // Locale prefix: the router matches the raw URL, so "/en/blog" arrives with
  // the prefix still in the segments. Strip it once here — ctx.pathname was
  // already canonicalized by the middleware, and every lookup below must see
  // the same canonical path. A page literally slugged "en" is shadowed by
  // the locale (standard i18n-routing trade-off).
  const segs = raw[0] === "en" ? raw.slice(1) : raw;
  // Bots probe unknown paths far more than humans follow broken links, and
  // they come back. A confirmed miss is remembered for 60s so a repeat hit
  // skips the per-type probes and the notFound render's reads entirely;
  // invalidateContentCaches() drops these on every content write, so a page
  // created at a previously-missed URL is reachable at once.
  const missKey = `pathmiss:${segs.join("/")}`;
  if (segs.length && peekMemo<boolean>(missKey, PATH_MISS_TTL) === true) return null;
  const res = await resolveSitePath(segs);
  if (!res) {
    // /search, /archives and /newsletter are real .rose pages at the bare
    // path; under the locale prefix the catch-all is what matches, so delegate
    // to their loaders here. Same {head, main} contract, query carried over
    // from the request. (These are the only three single-segment public
    // routes that are .rose pages rather than CMS content.)
    if (segs.length === 1 && segs[0] === "search") {
      const q = ctx.query;
      return {
        kind: "search",
        ...(await search(
          {
            q: q.get("q") || "",
            page: q.get("page"),
            all: q.get("all") === "1",
          },
          ctx,
        )),
      };
    }
    if (segs.length === 1 && segs[0] === "archives") {
      const q = ctx.query;
      return {
        kind: "archives",
        ...(await archives(
          {
            year: Number(q.get("year") || 0),
            month: Number(q.get("month") || 0),
          },
          ctx,
        )),
      };
    }
    // /en/newsletter: without this the English canonical the loader emits
    // would point at a 404 (the catch-all is what matches under the prefix).
    // `twin: true` makes main carry the form + its inline binder — this route
    // ships none of the page's client bundle, so the markup alone is inert.
    if (segs.length === 1 && segs[0] === "newsletter") {
      return { kind: "newsletter", ...(await newsletterPage({ twin: true }, ctx)) };
    }
    const decoded = segs
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .filter(Boolean);
    const sec = await getAdminSecurity();
    if (sec.entryEnabled && decoded.join("/") === sec.entryPath.replace(/^\//, "")) {
      const locale = localeOf(ctx);
      const t = makeT(locale);
      return {
        kind: "secret-entry",
        head: `<title>${t("login.page_title")}</title><meta name="robots" content="noindex, nofollow">`,
        main: secretEntryPageHtml(
          {
            enabled: sec.captchaEnabled,
            mode: sec.captchaEnabled ? sec.captchaMode : null,
          },
          t,
          locale
        ),
      };
    }
    const registerCfg = await getPublicRegisterConfig();
    if (
      registerCfg.enabled &&
      registerCfg.path === "/" + decoded.join("/")
    ) {
      const locale = localeOf(ctx);
      return { kind: "register", ...registerView(registerCfg, makeT(locale), locale) };
    }
    if (decoded.length === 1 && decoded[0] === "me") {
      const me = ctx.user as any;
      const route = me
        ? await renderUserCenter(me)
        : await renderUserCenterGuest();
      return { kind: "usercenter", ...userCenterView(route, ctx) };
    }
    const virtual = await resolveVirtualRoute(decoded);
    if (!virtual) {
      // Only a CONFIRMED miss is memoized. This write used to sit above the
      // fallback views, so a SUCCESSFUL register / secret-entry / user-center
      // / virtual-route render still planted the negative flag — and the flag
      // is keyed by the locale-stripped path, so the same page in the other
      // locale (/user rendered, then /en/user) 404'd for the next 60s.
      if (segs.length) await memoQuery(missKey, PATH_MISS_TTL, async () => true);
      return null;
    }
    return { kind: "virtual", ...virtualRouteView(virtual, ctx) };
  }
  const maintenance = await maintenanceGate((ctx.user as any) ?? null);
  if (maintenance) {
    return {
      kind: "maintenance",
      head: `<title>${R.esc(maintenance.title)}</title><meta name="robots" content="noindex, nofollow">`,
      main: maintenanceView(maintenance),
    };
  }
  const page = pageNum(payload.page);
  let out: Record<string, any>;
  switch (res.kind) {
    case "home":
      // home() was the ONE loader called without the request context, which is
      // why its canonical was always the bare "/" and its hreflang never saw
      // the real origin. Every other case passes ctx; so does home now.
      out = await home(ctx);
      break;
    case "post": {
      // R275/R280: the counterpart URL is resolved BEFORE postDetail — the
      // pair link the post page renders reads ctx.pairSwitchTarget, so it
      // must already be on the context when that loader runs (R280 bug: the
      // assignment after the await left the link empty on every paired page).
      if (res.post.post.translationOf) {
        const [c] = await rawQuery<{ id: number; slug: string; status: string; locale: string; pinyin_slug: string | null; initial_slug: string | null }>(
          `select id, slug, status, locale, pinyin_slug, initial_slug from posts where id = $1`,
          [res.post.post.translationOf],
        );
        if (c && c.status === "published") {
          const cfg = await getPermalinkConfig();
          const pairUrl = postUrlFor(cfg, {
            id: c.id, slug: c.slug, pinyinSlug: c.pinyin_slug, initialSlug: c.initial_slug,
          });
          // The target is the counterpart's OWN URL in ITS locale — the zh
          // original lives at the bare path (default = prefix-free). The
          // self row's locale is irrelevant to the destination.
          (ctx as { pairSwitchTarget?: string }).pairSwitchTarget =
            (c as { locale?: string }).locale === "en" ? `/en${pairUrl === "/" ? "" : pairUrl}` : pairUrl;
        }
      }
      out = await postDetail({ slug: res.post.post.slug, preloaded: res.post }, ctx);
      // R275: the view carries the counterpart URL for finalizeView's
      // per-post hreflang cluster (same data, one point query).
      const pairSwitchTarget = (ctx as { pairSwitchTarget?: string }).pairSwitchTarget;
      if (pairSwitchTarget) {
        // The switch target carries the localeHref prefix; the hreflang cluster
        // needs the raw counterpart path (its hrefs are absolute via origin).
        out.translationPair = {
          url: pairSwitchTarget.replace(/^\/en(?=\/|$)/, "") || "/",
          selfLocale: res.post.post.locale,
        };
      }
      break;
    }
    case "page":
      out = await pageDetail({ slug: res.page.slug, preloaded: res.page }, ctx);
      break;
    case "blogIndex":
      out = await blogList({ page }, ctx);
      break;
    case "pageIndex":
      out = await pageIndex(ctx);
      break;
    case "category":
      out = await categoryList({ slug: res.category.slug, page }, ctx);
      break;
    case "tag":
      out = await tagList({ slug: res.tag.slug, page }, ctx);
      break;
    case "author":
      out = await authorList({ authorId: res.authorId, page }, ctx);
      break;
  }
  if (out.notFound) return null;
  // _layout.rose supplies bodyOpen/bodyClose for the catch-all too — the
  // framework wraps every page in its directory's layout, so the layout's
  // $data("chrome") already ran in this render. Invoking loaders.chrome()
  // here rebuilt the whole chrome a second time (~12-24 DB queries) for
  // values nothing consumed.
  return { kind: res.kind === "blogIndex" ? "blog" : res.kind, ...out };
}

async function resolve(payload: { segments?: string[]; page?: number }, ctx: Ctx) {
  return finalizeView(await resolveInner(payload, ctx), ctx, localeOf(ctx));
}

/**
 * R193: the catch-all's second question, asked only after `resolve` answered
 * null. A rule turns "this path is gone" into "this path moved": the href
 * re-enters the visitor's own locale tree (a rule written for `/blog/old`
 * must not eject an `/en` reader into the Chinese URL, which is the same
 * mistake `searchRedirect` had to be patched for), and the status is 301 only
 * when the rule says it is permanent — a 301 is cached by browsers for the
 * life of the domain, so an operator who later deletes the rule would still
 * be shipping the move.
 */
async function redirectFor(payload: { segments?: string[] }, ctx: Ctx) {
  const path = `/${(payload?.segments ?? []).join("/")}`;
  const loc = localeOf(ctx);
  return ruleFor(path, (target) => canonicalPath(target, loc));
}

// --------------------------------------------------------- newsletter page

/**
 * The subscribe form's markup — defined ONCE, used by both routes that render
 * this page.
 *
 * It cannot live only in the .rose template: `/en/newsletter` is served by the
 * catch-all, like `/en/search` and `/en/archives`, and the catch-all renders
 * `{@html main}` and nothing else. A form written only in the page template
 * would be missing on the English twin — the page the locale switcher on
 * /newsletter points at. The twin therefore gets form markup inside `main`
 * plus its own inline binder (it ships none of this page's client bundle).
 */
function newsletterFormHtml(t: Translate): string {
  // `novalidate` on purpose: the endpoint already owns the one definition of
  // "a valid address" (api.email_invalid), and the page's contract is to
  // surface THAT answer. Native validation would intercept the typo first and
  // the 422 branch would never be reachable in a real browser. type="email" +
  // required stay for the mobile keyboard and for assistive tech.
  return (
    `<form data-nl-form novalidate>` +
    `<label class="text-sm mt-4 block" for="nl-email">${R.esc(t("newsletter.email_label"))}</label>` +
    `<div class="df-search-box df-search-box-block mt-2">` +
    `<input class="df-search-input" id="nl-email" data-nl-email name="email" ` +
    `type="email" required autocomplete="email" placeholder="${R.esc(t("newsletter.placeholder"))}">` +
    `</div>` +
    `<div class="flex items-center justify-between gap-2 mt-4">` +
    `<button class="btn-accent px-5 py-2" type="submit">${R.esc(t("newsletter.submit"))}</button>` +
    `</div>` +
    `</form>`
  );
}

/**
 * The public double-opt-in subscribe page (/newsletter). Deliberately thin —
 * the page owns the interactive form, this owns only what must be
 * request-scoped and translated:
 *
 *   - `head`: the whole SEO contract. Self-canonical per locale through
 *     canonicalPath (so /en/newsletter canonicalises to itself, not to the
 *     Chinese URL) and `noindex, follow` — a subscribe form is a utility
 *     page, not content, and it must never reach an index or a sitemap;
 *   - `main`: heading + lead + the complete subscribe form, so BOTH routes
 *     that render this page carry a usable form (see newsletterFormHtml);
 *   - `s`: the catalogue-baked strings the page's own template binds. Same shape
 *     as the admin loaders — the page never calls makeT itself for anything
 *     a visitor can read;
 *   - `locale`: the request locale, so the client-side POST sends the same
 *     language the page was rendered in without re-deriving it from the URL.
 *
 * It reads settings only for the title — no theme chrome, no widgets, no
 * post queries: the layout already ships all of that around this loader's
 * output.
 */
export async function newsletterPage(payload: { twin?: boolean } | undefined, ctx?: Ctx) {
  const locale = localeOf(ctx);
  const t = makeT(locale);
  const settings = await getSettings();
  const siteTitle = settings.siteTitle ?? "";
  const canonical = `${ctx?.origin ?? ""}${canonicalPath("/newsletter", locale)}`;
  const pageTitle = siteTitle ? `${t("newsletter.title")} - ${siteTitle}` : t("newsletter.title");
  const lead = t("newsletter.lead");
  const head =
    `<title>${R.esc(pageTitle)}</title>` +
    `<meta name="robots" content="noindex, follow">` +
    `<link rel="canonical" href="${R.esc(canonical)}">` +
    `<meta name="description" content="${R.esc(lead)}">` +
    `<meta property="og:title" content="${R.esc(pageTitle)}">` +
    `<meta property="og:description" content="${R.esc(lead)}">` +
    `<meta property="og:url" content="${R.esc(canonical)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="${R.esc(siteTitle)}">`;
  // `/en/newsletter` is served by the CATCH-ALL (pages/[[...slug]].rose) —
  // the same route `/en/search` and `/en/archives` ride — and the catch-all
  // emits `{@html main}` and nothing else. A form written only in
  // newsletter.rose's template would therefore be missing on the English twin,
  // which is exactly where the locale switcher on /newsletter points. So the
  // markup is defined once, in newsletterFormHtml, and `main` carries it with
  // an inline binder. The zh route renders `form` through its own $state
  // template instead; both post to the same endpoint with the same three
  // outcomes and read nothing but the status code (the endpoint's answer is
  // deliberately uniform, so it cannot be used to probe the list).
  const form = newsletterFormHtml(t);
  const heading =
    `<h1 class="text-3xl font-bold text-zinc-100">${R.esc(t("newsletter.title"))}</h1>` +
    `<p class="mt-2 text-sm text-zinc-400">${R.esc(lead)}</p>`;
  const twinMsgs = JSON.stringify({
    ok: t("newsletter.confirm_pending"),
    invalid: t("api.email_invalid"),
    failed: t("newsletter.failed"),
  });
  const twinScript =
    `<script>(function(){` +
    `var f=document.querySelector("[data-nl-form]");if(!f)return;` +
    `var m=document.querySelector("[data-nl-status]");` +
    `var M=${twinMsgs};` +
    `function say(k){if(!m)return;m.hidden=false;m.textContent=M[k];` +
    `m.style.color=k==="ok"?"#4ade80":"#f87171";}` +
    `f.addEventListener("submit",function(e){e.preventDefault();` +
    `var i=f.querySelector("[data-nl-email]");var v=i?i.value:"";` +
    `fetch("/api/newsletter/subscribe",{method:"POST",` +
    `headers:{"content-type":"application/json"},` +
    `body:JSON.stringify({email:v,locale:${JSON.stringify(locale)}})})` +
    `.then(function(r){return r.status===422?"invalid":r.ok?"ok":"failed";},function(){return "failed";})` +
    `.then(say);});})();</script>`;
  const main =
    payload && payload.twin
      ? `<section class="df-card">` +
        heading +
        form +
        `<p class="df-suggest-status mt-2" data-nl-status hidden role="status"></p>` +
        `</section>` +
        twinScript
      : heading;
  const s = {
    title: t("newsletter.title"),
    email_label: t("newsletter.email_label"),
    placeholder: t("newsletter.placeholder"),
    submit: t("newsletter.submit"),
    confirm_pending: t("newsletter.confirm_pending"),
    // The 422 the endpoint answers is api.email_invalid — reusing the same key
    // keeps the page's wording byte-identical to the server's, so a visitor
    // never sees two phrasings of one error.
    email_invalid: t("api.email_invalid"),
    failed: t("newsletter.failed"),
  };
  // `form` is the same markup the twin's `main` carries: the .rose page
  // renders it through its own reactive template so the status line can be
  // driven by $state rather than by DOM mutation.
  return { head, main, form, s, locale };
}

// ----------------------------------------------------------------- registry

async function loginCard() {
  const sec = await getAdminSecurity();
  return {
    html: loginCardHtml({
      enabled: sec.captchaEnabled,
      mode: sec.captchaEnabled ? sec.captchaMode : null,
    }),
  };
}

async function loginBrand() {
  const settings = await getSettings();
  return { siteTitle: settings.siteTitle ?? "" };
}

/**
 * Boot warmup's dynamic URLs: one real post, one category page, one tag page.
 *
 * The framework's warm loop only renders fixed routes, and the catch-all's
 * 404 probe never reaches the entity tables (post metas, taxonomy joins,
 * comments) — the first crawler of a real post page paid those tables'
 * first-touch plan compile. Surfaced to the prod server through the loader
 * registry as `warmUrls`. Every read here is memoized, so on a warm process
 * this costs nothing and returns stable paths.
 */
/**
 * Fire the shared read wave once (settings, taxonomies, lists, theme).
 * Every read here is memoized, so this is a no-op on a warm process. On
 * Vercel there is no boot warm, so the FIRST visitor pays this whole
 * wave; calling it fire-and-forget on that first request moves the cost
 * into the background and its instance-mates hit warm memos.
 */
export async function warmReadWave(): Promise<void> {
  // R274: the pairing flag starts false every process. Probe it here (the
  // boot read wave) so a site that already has translation pairs comes up
  // with self-canonical /en and a live hreflang cluster — without waiting for
  // the first content write to re-probe.
  try {
    const rows = await rawQuery<{ n: number }>(
      `select count(*)::int as n from posts where translation_of is not null`,
    );
    setPairingActive(Number(rows[0]?.n ?? 0) > 0);
  } catch {
    /* a probe failure leaves the flag false: R269 semantics, always safe */
  }
  await Promise.all([
    getSettings(),
    getActiveThemeSlug(),
    getActiveThemeSettings(),
    getPermalinkConfig(),
    listCategories(),
    listTags(),
    listPosts({ status: "published", limit: 12 }),
  ]);
}

export async function warmEntityUrls(): Promise<string[]> {
  const [posts, cats, tags, cfg] = await Promise.all([
    listPosts({ status: "published", limit: 1 }),
    listCategories(),
    listTags(),
    getPermalinkConfig(),
  ]);
  // The English tree is first-class: the warm loop must cover its variants
  // too, or the first /en visitor pays the cold-start wave the zh visitor no
  // longer does. The prod server caps extras at 8, so this list is capped too.
  const urls = [
    posts.items[0]?.url,
    cats[0] ? categoryUrlFor(cfg, cats[0]) : undefined,
    tags[0] ? tagUrlFor(cfg, tags[0]) : undefined,
  ].filter((u): u is string => typeof u === "string" && u.startsWith("/"));
  const enUrls = urls.map((u) => canonicalPath(u, "en"));
  return [...urls, "/en", "/en/blog", ...enUrls]
    .filter((u, i, all) => all.indexOf(u) === i && u.startsWith("/"))
    .slice(0, 8);
}

export const loaders = {
  chrome,
  loginCard,
  loginBrand,
  home,
  blog: blogList,
  category: categoryList,
  tag: tagList,
  search,
  post: postDetail,
  page: pageDetail,
  // R214: `archives.rose` loads this key directly (not via the catch-all's
  // `resolve`), so it skipped finalizeView and shipped 0 hreflang links —
  // /archives and /en/archives were never paired. Wrap it here so the same
  // post-processing every other view gets (hreflang + locale-prefixed links)
  // reaches this one too.
  archives: async (payload: { year?: number; month?: number }, ctx?: Ctx) =>
    finalizeView(await archives(payload, ctx), ctx as Ctx, localeOf(ctx)),
  // The public subscribe page (`pages/newsletter.rose` loads this key).
  newsletter: newsletterPage,
  notFound,
  resolve,
  redirectFor,
  // admin screens (all per-request DB reads, session-gated)
  "admin.session": admin.adminSession,
  "admin.setup": admin.adminSetup,
  "admin.dashboard": admin.adminDashboard,
  "admin.posts": admin.adminPosts,
  "admin.post": admin.adminPost,
  "admin.pages": admin.adminPages,
  "admin.page": admin.adminPage,
  "admin.comments": admin.adminComments,
  "admin.newsletter": admin.adminNewsletter,
  "admin.media": admin.adminMedia,
  "admin.menus": admin.adminMenus,
  "admin.widgets": admin.adminWidgets,
  "admin.themes": admin.adminThemes,
  "admin.theme-panel": admin.adminThemePanel,
  "admin.plugins": admin.adminPlugins,
  "admin.plugin": admin.adminPlugin,
  "admin.plugin-panel": admin.adminPluginPanel,
  "admin.menu-settings": admin.adminMenuSettings,
  "admin.taxonomies": admin.adminTaxonomies,
  "admin.users": admin.adminUsers,
  "admin.settings": admin.adminSettings,
  "admin.notify": admin.adminNotify,
  "admin.members": admin.adminMembers,
  "admin.account": admin.adminAccount,
  "admin.security": admin.adminSecurity,
  "admin.security-public": admin.adminSecurityPublic,
  "admin.oauth": admin.adminOAuth,
  "admin.permalinks": admin.adminPermalinks,
  "admin.redirects": admin.adminRedirects,
  "admin.maintenance": admin.adminMaintenance,
  "admin.security-logs": admin.adminSecurityLogs,
  "admin.icons": admin.adminIcons,
  "admin.searchTerms": admin.adminSearchTerms,
  "admin.webmentions": admin.adminWebmentions,
  "notFoundConfig": admin.notFoundConfig,
};
export type LoaderKey = keyof typeof loaders;

/** Server-only dispatch used by pages and by /api/data. */
export async function dispatch(key: string, payload: any, ctx: Ctx): Promise<unknown> {
  // Admin screens bring their own shell (pages/admin/_layout.rose): skip the
  // public chrome's DB work entirely and hand the root layout an empty stub.
  if (key === "chrome" && ctx.pathname && ctx.pathname.indexOf("/admin") === 0) {
    return {
      siteTitle: "管理后台",
      siteDescription: "",
      siteUrl: "",
      themeHead: "",
      // Admin is dark-only (body carries bg-zinc-950 = #09090b), so a single
      // unprefixed tint is correct under either OS preference.
      themeColorHtml: '<meta name="theme-color" content="#09090b">',
      nav: "",
      aside: "",
      footer: "",
      pluginHead: "",
      pluginFooter: "",
      // The layout reads these unconditionally; the admin never shows a
      // locale switcher, so both are the default-locale constants.
      htmlLang: htmlLangOf(DEFAULT_LOCALE),
      locale: DEFAULT_LOCALE,
    };
  }
  const fn = (loaders as Record<string, (p: any, c: Ctx) => Promise<unknown>>)[key];
  if (!fn) throw new Error(`unknown loader: ${key}`);
  return fn(payload ?? {}, ctx);
}

/** Raw document builders for middleware-intercepted XML/txt routes. */
export const documents = {
  feed,
  jsonFeed,
  commentsFeed,
  commentsJsonFeed,
  taxonomyFeed,
  taxonomyJsonFeed,
  robots,
  manifest,
};
