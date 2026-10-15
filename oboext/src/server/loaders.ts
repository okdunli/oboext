// Isomorphic view-model layer.
import {
  archiveGroups,
  archiveItems,
  counts,
  getCategoryBySlug,
  getPostRow,
  hydrate,
  getSettings,
  getTagBySlug,
  incrementViews,
  categoryPostCounts,
  listCategories,
  listPosts,
  listPostComments,
  listPostCommentsCached,
  listTags,
  popularPosts,
  randomPosts,
  relatedPosts,
  relatedByTaxonomy,
  searchSingleHit,
  type PostView,
  type PostRow,
  type TaxRef,
} from "./queries.js";
import { dbStats } from "./db.js";
import { getPermalinkConfig, blogIndexUrlFor, categoryUrlFor, tagUrlFor, resolveSitePath, paginate, type PermalinkConfig } from "./links.js";
import { resolveVirtualRoute, type VirtualSiteRoute } from "./virtual-routes.js";
import { resolveCommentConfig } from "./comments-config.js";
import { getPublishedPageRow, hydrate as hydratePage, listPublishedPages } from "./pages.js";
import * as R from "./render.js";
import * as admin from "./admin-loaders.js";
import { getMenuByLocation } from "./menus.js";
import { getAreaWidgets } from "./widgets.js";
import { getActiveThemeSlug, getActiveThemeRenderConfig, getActiveThemeSettings, getThemeManifest } from "./themes.js";
import { themeToCss, resolveThemeConfig } from "./theme-tokens.js";
import { skyscraperBridgeRoot, skyscraperBridgeDark, themeColorMetas } from "./theme-bridge.js";
import { HOOKS, applyFilters } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { getNotFoundSettings } from "./not-found-config.js";
import { memoQuery, peekMemo } from "./cache.js";
import { getPublicRegisterConfig } from "./members.js";
import { maintenanceGate, type MaintenanceSettings } from "./maintenance.js";
import { renderUserCenter, renderUserCenterGuest } from "./account.js";
import { loginCardHtml, secretEntryPageHtml } from "./login-card.js";
import { getAdminSecurity } from "./security.js";
import { can } from "./admin.js";
import { getThemeChrome, publicAssetHref, bluemixNotFoundPage, catIconName, type MenuItem } from "./theme-chrome.js";

export type Ctx = {
  query: URLSearchParams;
  origin: string;
  pathname: string;
  ip: string;
  ua: string;
  user?: unknown;
};

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
): HeadContext {
  if (pathname === "/") return { kind: "home", siteTitle, siteUrl: origin };
  if (pathname === blogIndex || pathname === blogIndex + "/")
    return {
      kind: "archive",
      siteTitle,
      siteUrl: origin,
      title: "所有文章",
      breadcrumbs: [
        { label: "首页", href: "/" },
        { label: "文章", href: blogIndex },
      ],
    };
  if (pathname.indexOf("/search") === 0)
    return { kind: "search", siteTitle, siteUrl: origin, title: "搜索" };
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

const pageNum = (v: unknown): number => Math.max(1, Number(v) || 1);

// ------------------------------------------------------------------- chrome

// Built-in sidebar used until an admin defines a "sidebar" menu; mirrors
// SKY_SIDEBAR_FALLBACK in themes/skyscraper/Layout.tsx, with the index URL
// driven by the permalink config so a renamed prefix rewires it too.
const sidebarFallback = (cfg: PermalinkConfig): R.SkyItem[] => [
  { id: "s1", label: "首页", url: "/" },
  { id: "s2", label: "所有文章", url: blogIndexUrlFor(cfg) },
];

// Plain trusted-string chrome pieces. chrome() hands them to the .rose
// templates (emitted via {@html}); the 404 route rides the same chrome
// through the framework's normal render pipeline.
async function chromeData(pathname: string) {
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
  // FRAMEWORK LIMITATION (rosefd 0.2.3, reported in rosefd/BUG.md):
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
  const skBase = (getThemeManifest(themeSlug)?.config ?? {}) as Parameters<
    typeof skyscraperBridgeRoot
  >[1];
  const skBridge =
    themeSlug === "skyscraper"
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
    sideMenu && sideMenu.items.length ? (sideMenu.items as R.SkyItem[]) : sidebarFallback(cfg);
  const tc = getThemeChrome(themeSlug);
  // Theme JS, mtime-stamped. Built here (not as `{chrome().x}` attributes in
  // the .rose layout) because the template compiler only interpolates
  // attributes it can resolve statically — a raw-HTML channel is the proven
  // path (same as bodyFix/nav/bodyOpen).
  const themeScripts =
    `<script src="${publicAssetHref("csrf.js")}" defer></script>` +
    (themeSlug === "skyscraper" ? `<script src="${publicAssetHref("theme.js")}" defer></script>` : "") +
    (themeSlug !== "skyscraper" ? `<script src="${publicAssetHref("theme-pjax.js")}" defer></script>` : "") +
    (themeSlug === "bluemix" ? `<script src="${publicAssetHref("theme-bluemix.js")}" defer></script>` : "") +
    `<script src="${publicAssetHref("comments.js")}" defer></script>`;
  const headerItems: MenuItem[] = (headerMenu?.items ?? []) as MenuItem[];

  const footerHtml = tc.footer(
    {
      ...settings,
      footerContainerAlign: (themeSettings as Record<string, unknown>).footerContainerAlign,
      footerMenu: (footerMenu?.items ?? []) as MenuItem[],
    },
    R.widgetAreaHtml(footerWidgets, "sk-footer-widgets"),
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
    varsHtml,
    siteHead: verificationMetaHtml(settings.verifications),
    themeColorHtml: themeColorMetas(renderConfig.background),
    siteBodyOpen,
    siteBodyEnd,
    themeSlug,
    cssHref: tc.cssHref(),
    // The inlined copy of the same stylesheet. Optional on the interface: a
    // theme that does not implement cssInline() yields "", and the layout then
    // emits only the <link>. Called through the same tc the rest of the chrome
    // comes from, so the two cannot drift onto different themes.
    cssInline: tc.cssInline ? tc.cssInline() : "",
    themeScripts,
    bodyFix: tc.bodyFix() + siteBodyOpen,
    headExtra: tc.headExtra(),
    navHtml: tc.nav({ ...settings, __pathname: pathname }, headerItems),
    bodyOpen: tc.bodyOpen({ ...settings, __pathname: pathname }, headerItems),
    bodyClose: tc.bodyClose(
      { ...settings, analyticsCode: (themeSettings as Record<string, unknown>).analyticsCode },
      footerHtml,
    ),
    asideHtml: tc.aside({
      menu: R.sidebarMenu(menuItems, pathname),
      tagCloud: R.tagCloud(tags),
      stats: R.blogStats(stats),
      popular: R.popularWidget(popular),
      widgets: R.widgetAreaHtml(sideWidgets, "sk-widget-area"),
    }),
    footerHtml,
  };
}

async function chrome(_payload: unknown, ctx?: Ctx) {
  const pathname = (ctx && ctx.pathname) || "/";
  const origin = (ctx && ctx.origin) || "";
  const statsOn = process.env.OBOEXT_DB_STATS === "1";
  const t0 = statsOn ? Date.now() : 0;
  const before = statsOn ? dbStats() : null;
  const [d, cfg] = await Promise.all([chromeData(pathname), getPermalinkConfig()]);
  const isAdmin = pathname.indexOf("/admin") === 0;
  const blogIndex = blogIndexUrlFor(cfg);
  // Independent reads: fetch them together instead of two serial awaits.
  const [pluginFooterRaw, pluginHead] = await Promise.all([
    isAdmin ? "" : pluginFooterHtml(chromePageKind(pathname, cfg)),
    isAdmin || chromeSkipsHead(pathname, cfg)
      ? ""
      : pluginHeadHtml(chromeHeadContext(pathname, d.siteTitle, origin, blogIndex)),
  ]);
  const pluginFooter = isAdmin ? "" : pluginFooterRaw + d.siteBodyEnd;
  if (statsOn) {
    const s = dbStats();
    const ms = Date.now() - t0;
    console.log(
      `[stats] chrome(${pathname}) queries=${s.count - (before?.count ?? 0)} ` +
        `dbTime=${s.total - (before?.total ?? 0)}ms wall=${ms}ms`,
    );
  }
  return {
    siteTitle: d.siteTitle,
    siteDescription: d.siteDescription,

    siteUrl: origin,
    siteHead: isAdmin ? "" : d.siteHead,
    themeColorHtml: d.themeColorHtml,
    // Site-level social card: the logo when one is set (absolute), the meta
    // set built from it, and "" for both when it is not.
    ogImage: d.logoUrl ? (d.logoUrl.startsWith("http") ? d.logoUrl : `${origin}${d.logoUrl}`) : "",
    ogImageHtml: isAdmin ? "" : R.socialImageMetas(d.logoUrl, origin, d.siteTitle),
    themeHead: d.varsHtml + d.headExtra,
    themeSlug: d.themeSlug,
    cssHref: d.cssHref,
    cssInline: d.cssInline,
    themeScripts: d.themeScripts,
    bodyFix: d.bodyFix,
    nav: d.navHtml,
    bodyOpen: d.bodyOpen,
    bodyClose: d.bodyClose,
    aside: d.asideHtml,
    footer: d.footerHtml,
    pluginFooter,
    pluginHead,
  };
}

// --------------------------------------------------------------------- home

// -------- bluemix home helpers (mirror themes/bluemix/HomePage.tsx logic) --------

async function sideWidgetsFor(themeSlug: string): Promise<string> {

  if (themeSlug !== "codeman" && themeSlug !== "pseudolinear") return "";
  const wrap = themeSlug === "pseudolinear" ? "pl-side-stack" : "sk-widget-area";
  return R.widgetAreaHtml(await getAreaWidgets(themeSlug, "sidebar"), wrap);
}

// Sync twin of sideWidgetsFor: identical markup, but over an area that was
// already read, so a post view does not issue the sidebar query twice.
function sideWidgetsHtml(
  themeSlug: string,
  items: Awaited<ReturnType<typeof getAreaWidgets>>,
): string {
  if (themeSlug !== "codeman" && themeSlug !== "pseudolinear") return "";
  const wrap = themeSlug === "pseudolinear" ? "pl-side-stack" : "sk-widget-area";
  return R.widgetAreaHtml(items, wrap);
}

async function bmixDrawerPosts(themeSlug: string): Promise<PostView[] | undefined> {
  if (themeSlug !== "bluemix") return undefined;
  // Sidebar reads run on every page: memoize 60s (new posts surface on the
  // next refresh, and the drawer is not a feed).
  const kvD = (globalThis as any).__rosefdKvApi?.kv;
  const key = "sidebar:drawer";
  const hit = kvD?.get(key) as PostView[] | undefined;
  if (hit) return hit;
  const { items } = await listPosts({ status: "published", limit: 8 });
  kvD?.set(key, items, 60);
  return items;
}

async function defaultSidebarData(want: boolean, showCatIcons = false): Promise<{ posts: PostView[]; tags: TaxRef[]; cats: TaxRef[]; showCatIcons: boolean; catCounts: Map<number, number> } | undefined> {
  if (!want) return undefined;
  const kvS = (globalThis as any).__rosefdKvApi?.kv;
  const sKey = `sidebar:default:${showCatIcons}`;
  const sHit = kvS?.get(sKey) as { items: PostView[]; tagRows: TaxRef[]; catRows: TaxRef[]; cfg: any; catCounts: Map<number, number> } | undefined;
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
  kvS?.set(sKey, { items, tagRows, catRows, cfg, catCounts }, 60);
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
  const kv = (globalThis as any).__rosefdKvApi?.kv;
  const cachedHome = kv?.get("home:bundle") as HomeBundle | undefined;
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
  if (!cachedHome) kv?.set("home:bundle", { all, popular, catRows, random }, 60);
  const homeLimit = themeSlug === "pseudolinear" ? 30 : 12;
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const items = all.items.slice(0, homeLimit);
  const tc = getThemeChrome(themeSlug);

  // non-bluemix themes render from the slim hero/latest split; skip the extra
  // queries so their home stays cheap.
  // mirror buildEntityMetadata(kind:"home")：canonical = origin。
  // WebSite JSON-LD rides the home head: SearchAction is only truthful here
  // (the /search route is the sitewide query target).
  const origin0 = ctx?.origin ?? "";
  const homeCanonical = origin0 ? `${origin0}/` : "/";
  const siteName = settings.siteTitle ?? "";
  const homeOgImage = settings.logoUrl ? R.esc(settings.logoUrl) : "";
  const homeHead =
    `<link rel="canonical" href="${R.esc(homeCanonical)}">` +
    `<meta property="og:site_name" content="${R.esc(siteName)}">` +
    (homeOgImage
      ? `<meta property="og:image" content="${homeOgImage}">` +
        `<meta name="twitter:image" content="${homeOgImage}">`
      : "") +
    R.jsonLd({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: siteName,
      description: settings.siteDescription ?? "",
      url: homeCanonical,
      potentialAction: {
        "@type": "SearchAction",
        target: `${homeCanonical}search?q={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    });
  if (themeSlug !== "bluemix") {
    // tagRows/ts/catCounts ride the opening wave (see above); widgetsP was
    // issued alongside it.
    const widgets = await widgetsP;
    const tags = tagRows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) }));
    return {
      head: homeHead,
      main: tc.home({

        hero: themeSlug === "pseudolinear" ? items : items.slice(0, 4),
        latest: themeSlug === "pseudolinear" ? [] : items.slice(4, 12),
        liked: popular.items,
        random,
        cats,
        tags,
        catCounts,
        total: all.total,
        widgets,
        settings,
        themeSettings: ts,
      }),
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
      settings,
      recent: recent.items as any[],
      sections: sections as any,
      rankings,
      rankTabs,
      themeSettings: ts,
      blogIndex,
      showHero,
      bannerMax,
      recentCount,
      homeTop: R.widgetAreaHtml(homeTopItems, "container-np bmx-ad-area"),
      sideWidgets: R.widgetAreaHtml(homeSideItems, "bmx-ad-area"),
    }),
  };
}

// ------------------------------------------------------------- list routing

async function blogList(payload: { page?: number }, ctx?: Ctx) {
  // Sidebar batch pre-issues off the themeSlug/themeSettings reads below, so
  // its queries overlap the pager window's wave instead of following it.
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s === "default");
  const [settings, themeSlug, cfg, catRows, all, ts] = await Promise.all([
    getSettings(),
    themeSlugP,
    getPermalinkConfig(),
    listCategories(),
    listPosts({ status: "published", limit: 5, orderBy: "views" }),
    tsP,
  ]);

  const perPage =
    themeSlug === "bluemix"
      ? Math.min(100, Math.max(1, Number(settings.postsPerPage) || 10))
      : themeSlug === "skyscraper"
        ? settings.postsPerPage || 10
        : settings.postsPerPage || 12;
  const page = pageNum(payload.page);
  const { items, total } = await listPosts({
    status: "published",
    limit: perPage,
    offset: (page - 1) * perPage,
  });
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const blogIndex = blogIndexUrlFor(cfg);
  const [widgets, drawerPosts, sidebarData] = await sideP;
  const tc = getThemeChrome(themeSlug);

  const siteTitle = settings.siteTitle ?? "";
  const seoTitle = `文章 - ${siteTitle}`;
  const blogUrl = `${ctx?.origin ?? ""}${blogIndex}`;
  return {
    headTitle: seoTitle,
    head:
      `<link rel="canonical" href="${R.esc(blogUrl)}">` +
      `<meta name="description" content="${R.esc(settings.siteDescription ?? "")}">` +
      `<meta name="robots" content="index, follow">` +
      `<meta property="og:title" content="${R.esc(seoTitle)}">` +
      `<meta property="og:description" content="${R.esc(settings.siteDescription ?? "")}">` +
      `<meta property="og:url" content="${R.esc(blogUrl)}">` +
      `<meta property="og:type" content="website">` +
      `<meta property="og:site_name" content="${R.esc(siteTitle)}">` +
      (settings.logoUrl ? `<meta property="og:image" content="${R.esc(settings.logoUrl)}">` : "") +
      `<meta name="twitter:card" content="summary_large_image">` +
      `<meta name="twitter:title" content="${R.esc(seoTitle)}">` +
      `<meta name="twitter:description" content="${R.esc(settings.siteDescription ?? "")}">` +
      (settings.logoUrl ? `<meta name="twitter:image" content="${R.esc(settings.logoUrl)}">` : ""),
    main: tc.listPage({

      title: themeSlug === "bluemix" ? `最新文章 · ${total} 篇` : "全部文章",
      sub: `共 ${total} 篇 · 第 ${page}/${totalPages} 页`,
      items,
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
      settings,
      themeSettings: ts,

      total,
    }),
  };
}

async function categoryList(payload: { slug: string; page?: number }, ctx: Ctx) {
  const page = pageNum(payload.page);
  // Sidebar batch pre-issues off the themeSlug/themeSettings reads below
  // (same pattern as blogList).
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s === "default");
  const [category, settings, cfg, themeSlug, catRows, ts] = await Promise.all([
    getCategoryBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
    themeSlugP,
    listCategories(),
    tsP,
  ]);
  if (!category) return { notFound: true };
  const isSk = themeSlug === "skyscraper";
  const catPerPage = isSk ? settings.postsPerPage || 10 : themeSlug === "codeman" || themeSlug === "pseudolinear" ? 30 : 12;
  // Category listing: memoize the page's post window for 2 minutes (a new
  // post surfaces on refresh or an admin write invalidates by TTL).
  const catKey = `cat:${payload.slug}:${page}:${themeSlug}`;
  const kvCat = (globalThis as any).__rosefdKvApi?.kv;
  const cachedCat = kvCat?.get(catKey) as { items: any[]; total: number } | undefined;
  const { items, total } = cachedCat ?? await listPosts({
    status: "published",
    categorySlug: payload.slug,
    limit: catPerPage,
    offset: isSk ? (page - 1) * catPerPage : 0,
    ...(isSk ? {} : { page }),
  });
  if (!cachedCat) kvCat?.set(catKey, { items, total }, 120);
  const totalPages = Math.max(1, Math.ceil(total / catPerPage));
  const catUrl = categoryUrlFor(cfg, category);
  const pluginHead = await pluginHeadHtml({
    kind: "taxonomy",
    siteTitle: settings.siteTitle ?? "",
    siteUrl: ctx.origin,
    title: category.name,
    description: category.description || settings.siteDescription || "",
    url: `${ctx.origin}${catUrl}`,
    breadcrumbs: [
      { label: "首页", href: "/" },
      { label: category.name, href: catUrl },
    ],
  });
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const [widgets, drawerPosts, sidebarData] = await sideP;
  const tc = getThemeChrome(themeSlug);

  const sub = isSk
    ? `${category.description ? `<span>${category.description} · </span>` : ""}共 ${total} 篇 · 第 ${page}/${totalPages} 页`
    : "";
  return {
    headTitle: `分类：${category.name} - ${settings.siteTitle ?? ""}`,
    pluginHead,
    main: tc.listPage({
      title:
        themeSlug === "bluemix" || themeSlug === "codeman" || themeSlug === "pseudolinear"
          ? category.name
          : `分类：${category.name}`,
      sub,
      items,
      page,
      totalPages,
      hrefFor: (n) => paginate(catUrl, n),
      showPager: isSk ? total > catPerPage : false,
      hero: items.slice(0, 5),
      cats,
      blogIndex: blogIndexUrlFor(cfg),
      bannerMax: bmClamp(ts.bannerMaxCount, 5, 1, 10),
      activeHref: catUrl,
      variant: "category",
      widgets,
      drawerPosts,
      sidebarData,
      settings,
      themeSettings: ts,

      titleIcon: themeSlug === "bluemix"
        ? (ts.useCustomIcons !== false ? catIconName(category) : null)
        : (ts.useCustomIcons === true ? catIconName(category) : null),
      titleDesc: category.description || "",
    }),
  };
}

async function tagList(payload: { slug: string; page?: number }, ctx: Ctx) {
  const page = pageNum(payload.page);
  // Sidebar batch pre-issues off the themeSlug/themeSettings reads below
  // (same pattern as blogList/categoryList).
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s !== "skyscraper");
  const [tag, settings, cfg, themeSlug, ts] = await Promise.all([
    getTagBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
    themeSlugP,
    tsP,
  ]);
  if (!tag) return { notFound: true };

  const isSk = themeSlug === "skyscraper";
  const tagPerPage = isSk ? settings.postsPerPage || 10 : 12;
  const { items, total } = await listPosts({
    status: "published",
    tagSlug: payload.slug,
    limit: tagPerPage,
    offset: isSk ? (page - 1) * tagPerPage : 0,
  });
  const totalPages = Math.max(1, Math.ceil(total / tagPerPage));
  const tagUrl = tagUrlFor(cfg, tag);
  const pluginHead = await pluginHeadHtml({
    kind: "taxonomy",
    siteTitle: settings.siteTitle ?? "",
    siteUrl: ctx.origin,
    title: `#${tag.name}`,
    description: settings.siteDescription || "",
    url: `${ctx.origin}${tagUrl}`,
    breadcrumbs: [
      { label: "首页", href: "/" },
      { label: `#${tag.name}`, href: tagUrl },
    ],
  });
  const [widgets, drawerPosts, sidebarData] = await sideP;
  const tc = getThemeChrome(themeSlug);

  const contentTc = isSk ? tc : getThemeChrome("default");
  return {
    headTitle: `标签：#${tag.name} - ${settings.siteTitle ?? ""}`,
    pluginHead,
    main: contentTc.listPage({
      title: `标签：#${tag.name}`,

      sub: isSk ? `共 ${total} 篇 · 第 ${page}/${totalPages} 页` : "",
      items,
      page,
      totalPages,
      hrefFor: (n) => paginate(tagUrl, n),
      showPager: isSk ? total > tagPerPage : false,
      variant: "term",
      widgets,
      drawerPosts,

      sidebarData,
      settings,
      themeSettings: ts,
    }),
  };
}

async function search(payload: { q?: string; page?: number; all?: boolean }, ctx?: Ctx) {
  const q = (payload.q ?? "").trim();
  const cleaned = q;
  const page = payload.page ?? 1;
  // All reads below (settings, themeSlug, sidebar batch) pre-issue here so
  // they pipeline with the results query instead of queueing behind it; the
  // old shape awaited settings -> themeSlug serially, then re-read both
  // (getSettings twice, themeSettings alone) after the results wave.
  const settingsP = safe(getSettings());
  const themeSlugP = safe(getActiveThemeSlug());
  const tsP = safe(getActiveThemeSettings());
  const sideP = sidebarBatchP(themeSlugP, tsP, (s) => s === "default");
  const settings0 = await settingsP;
  const themeSlug = await themeSlugP;

  const isBm = themeSlug === "bluemix";
  const isSk = themeSlug === "skyscraper";
  const perPage = isBm
    ? Math.min(100, Math.max(1, Number(settings0.postsPerPage) || 10))
    : isSk
      ? 20
      : themeSlug === "codeman" || themeSlug === "pseudolinear"
        ? 30
        : 20;
  const paged = isBm || isSk;
  const { items, total } = cleaned
    ? await listPosts({
        status: "published",
        search: cleaned,
        limit: perPage,
        offset: paged ? (page - 1) * perPage : 0,
      })
    : { items: [] as PostView[], total: 0 };
  const totalPages = Math.max(1, Math.ceil(total / perPage));
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
      ? `<div class="sk-search-all">没有想找的内容？<a href="/search?q=${encodeURIComponent(
          cleaned,
        )}&all=1">查看全部结果</a></div>`
      : "";
  const [settings, ts] = await Promise.all([settingsP, tsP]);
  const [widgets, drawerPosts, sidebarData] = await sideP;

  const searchSiteTitle = settings.siteTitle ?? "";
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
  const searchHead =
    `<meta property="og:url" content="${R.esc(ctx?.origin ?? "")}">` +
    `<meta property="og:site_name" content="${R.esc(searchSiteTitle)}">` +
    `<meta property="og:locale" content="zh_CN">` +
    searchHighlight;
  return {
    head: searchHead,
    main: getThemeChrome(themeSlug || "skyscraper").listPage({

      title: cleaned ? (isBm ? `搜索 “${cleaned}” · ${total} 篇` : `搜索：“${cleaned}”`) : "搜索",

      sub: isBm || themeSlug === "codeman" || themeSlug === "pseudolinear"
        ? ""
        : cleaned
          ? isSk
            ? `共 ${total} 条结果 · 第 ${page}/${totalPages} 页`
            : `找到 ${items.length} 篇结果`
          : isSk
            ? "在顶部搜索框输入关键词"
            : "",
      items,
      page,
      totalPages,
      hrefFor,
      showPager: paged ? total > perPage : false,
      extra: isBm || isSk ? extra : "",
      variant: "search",
      titleIcon: isBm ? null : "search",
      query: cleaned,
      widgets,
      drawerPosts,

      sidebarData,
      settings,
      themeSettings: ts,
      emptyHint: isBm && !cleaned ? "输入关键词，从右上角搜索框或导航搜索寻找内容。" : undefined,
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
): Promise<[string, PostView[] | undefined, Awaited<ReturnType<typeof defaultSidebarData>>]> {
  const p = Promise.all([themeSlugP, tsP]).then(([s, t]) =>
    Promise.all([
      sideWidgetsFor(s),
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
  const themeSlug = await themeSlugP;
  const postId = row.post.id;

  const relatedN = themeSlug === "codeman" || themeSlug === "pseudolinear" ? 5 : 4;
  // Only three themes render `related` (bluemix / pseudolinear / codeman);
  // the default theme's post page reads relatedTaxonomy alone and skyscraper
  // reads neither. Computing the date-based set unconditionally ran ~6
  // pointless queries per post view on every per-cookie render-cache miss.
  const usesRelated = themeSlug === "bluemix" || themeSlug === "pseudolinear" || themeSlug === "codeman";
  const highlight = themeSlug === "skyscraper" || themeSlug === "bluemix";
  const isDefault = themeSlug === "default";
  const isBluemix = themeSlug === "bluemix";
  // Bluemix renders both areas too (PostPage.tsx: sidebar after PostSidebar).
  // Every theme but skyscraper renders a sidebar area, so the sidebar read is
  // not gated on widgetAreas - codeman/pseudolinear paint it through `widgets`.
  const widgetAreas = isDefault || isBluemix;
  const wantsSidebar = themeSlug !== "skyscraper";
  // The view-count write used to be awaited AFTER the reads block — a whole
  // extra serial round trip on Neon (~550ms) tacked onto every render-cache
  // miss. It reads nothing the reads produce, so it rides the same wave and
  // is still awaited (best effort: a stats failure never breaks the page).
  const viewsWrite = (async () => {
    if (ctx.ip || ctx.ua) {
      try {
        await incrementViews(postId, ctx.ip, ctx.ua);
      } catch {
        /* */
      }
    }
  })();
  // One hydration, three consumers. The body render and the plugin head chain
  // off it, so body rendering (pure CPU without DB-backed shortcodes, one
  // round trip with them) overlaps the reads wave instead of running after it,
  // and the head follows the post instead of re-reading anything.
  const hydratedP = safe(hydrate(row));
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
        { label: "首页", href: "/" },
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
    themeSlug === "default" ? relatedByTaxonomy(postId, 4) : Promise.resolve(undefined),
    widgetAreas
      ? getAreaWidgets(themeSlug, "post-bottom")
      : Promise.resolve<Awaited<ReturnType<typeof getAreaWidgets>>>([]),
    wantsSidebar
      ? getAreaWidgets(themeSlug, "sidebar")
      : Promise.resolve<Awaited<ReturnType<typeof getAreaWidgets>>>([]),
    sideDataP ?? Promise.resolve(undefined),
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

    authorUrlLabel: "链接",
    defaultContent: config.defaultContent,
    me,
    items,
    avatar: config.avatar,
    config: { ...config },
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
  metaPayload.items.unshift({ label: "阅读时长", value: `约 ${readMinutes} 分钟` });
  const metaHtml = metaPayload.items.length
    ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--muted)">${metaPayload.items.map((m) => `<span>${R.esc(m.label)}：${R.esc(m.value)}</span>`).join("")}</div>`
    : "";
  const tagsHtml = (post.tags || []).length
    ? `<div style="margin-top:32px;display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid var(--border);padding-top:24px">${(post.tags || []).map((t) => `<a href="${R.esc(t.url || tagUrlFor(cfg, t))}" style="font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--border);padding:4px 12px;border-radius:9999px">#${R.esc(t.name)}</a>`).join("")}</div>`
    : "";
  const shareHtml = R.shareBar(post, settings.siteTitle ?? "", settings.siteDescription ?? "");

  const defMetaHtml = metaPayload.items.length
    ? `<div class="mt-2 flex flex-wrap items-center gap-4 text-sm text-[var(--muted)]">${metaPayload.items.map((m) => `<span>${R.esc(m.label)}：${R.esc(m.value)}</span>`).join("")}</div>`
    : "";
  const defTagsHtml = (post.tags || []).length
    ? `<div class="mt-8 flex flex-wrap gap-2 border-t border-[var(--border)] pt-6">${(post.tags || []).map((t) => `<a href="${R.esc(t.url || tagUrlFor(cfg, t))}" class="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]">#${R.esc(t.name)}</a>`).join("")}</div>`
    : "";

  // Sidebar widgets for codeman/pseudolinear paint the area read in the
  // opening wave; the other themes return "" and use sidebarWidgets below.
  const widgets = sideWidgetsHtml(themeSlug, sideItems);
  const postBottom = widgetAreas
    ? R.widgetAreaHtml(bottomItems, isBluemix ? "model-wrapper bmx-ad-area" : "space-y-6")
    : "";
  const sidebarWidgets = widgetAreas
    ? R.widgetAreaHtml(sideItems, isBluemix ? "bmx-ad-area" : "space-y-6")
    : "";
  // F7: the preview banner rides the rendered main for managers/authors on
  // unpublished posts only - a fixed bar over the theme's own chrome.
  const previewBanner = previewing
    ? `<div style="position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#d97706;color:#fff;padding:6px 16px;text-align:center;font:600 14px/1.5 system-ui,sans-serif">` +
      `Preview mode: this content is not yet published (status: ${R.esc(post.status)}${post.publishedAt && new Date(post.publishedAt) > new Date() ? `, scheduled for ${new Date(post.publishedAt).toLocaleString("zh-CN")}` : ""}) — visible to administrators and the author only` +
      `</div>`
    : "";
  return {
    main: previewBanner + tc.postPage({
      post,
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
      shareHtml,
      blogIndex: blogIndexUrlFor(cfg),
      widgets,
      postBottom,
      sidebarWidgets,

      sidebarData,
      settings,
      canonical: `${ctx.origin}${post.url}`,
    }),
    head:
      R.postHead(post, settings.siteTitle ?? "", settings.siteDescription ?? "", ctx.origin, settings.logoUrl, { wordCount: readWordCount, minutes: readMinutes }) +
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
            { label: "首页", href: "/" },
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

    authorUrlLabel: "链接",
    defaultContent: config.defaultContent,
    me,
    items,
    avatar: config.avatar,
    config: { ...config },
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
    }),
    head:
      R.pageHead(page, settings.siteTitle ?? "", settings.siteDescription ?? "", ctx.origin, settings.logoUrl, { wordCount: pgWordCount, minutes: pgMinutes }) +
      pluginHead,
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

const POST_FORMAT_LABELS: Record<string, string> = {
  standard: "标准",
  aside: "日志",
  quote: "引语",
  link: "链接",
  image: "图片",
  gallery: "相册",
  video: "视频",
  audio: "音频",
  status: "状态",
};

async function archives(payload: { year?: number; month?: number }, ctx?: Ctx) {
  const year = Number(payload.year) || 0;
  const month = Number(payload.month) || 0;
  const esc = R.esc;
  // Archives scans up to 1000 posts on every visit: memoize the whole read
  // set for 5 minutes (archives change rarely, and a new post shows up on the
  // next refresh or an admin write).
  const archKey = `archives:${year}:${month}`;
  const kv = (globalThis as any).__rosefdKvApi?.kv;
  const cached = kv?.get(archKey) as
    | { settings: any; index: any; total: number; items: any[] }
    | undefined;
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
        limit: 1000,
      }),
    ]);
    kv?.set(archKey, { settings, index, total, items }, 300);
  }
  const filtered = !!(year || month);

  const buckets = new Map<string, typeof items>();
  for (const e of items) {
    const d = e.publishedAt ? new Date(e.publishedAt) : null;
    const key = d ? `${d.getFullYear()}-${d.getMonth() + 1}` : "未发布";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(e);
  }

  const sections = [...buckets.entries()]
    .map(([key, list]) => {
      const lis = list
        .map((p) => {
          const fmt = POST_FORMAT_LABELS[p.format ?? "standard"];
          const badge =
            fmt && p.format !== "standard"
              ? `<span class="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style="background:var(--accent-soft);color:var(--accent)">${esc(fmt)}</span>`
              : "";
          return (
            `<li><a class="group flex items-baseline gap-3 rounded-md px-2 py-1.5 transition" style="color:var(--text)" href="${esc(p.url)}">` +
            `<span class="w-20 shrink-0 font-mono text-xs tabular-nums" style="color:var(--muted)">${esc(R.formatSiteDate(p.publishedAt, settings as any))}</span>` +
            `<span class="flex-1 group-hover:underline">${esc(p.title)}</span>${badge}` +
            `<span class="hidden shrink-0 items-center gap-1 text-[11px] sm:flex" style="color:var(--muted)">${EYE_SVG} ${esc(p.views)}</span>` +
            `</a></li>`
          );
        })
        .join("");
      const label = key === "未发布" ? key : key.replace("-", " 年 ") + " 月";
      return (
        `<section><h2 class="mb-3 border-b pb-1.5 text-sm font-semibold" style="border-color:var(--border);color:var(--muted)">` +
        `${esc(label)}<span class="ml-2 text-xs opacity-60">${list.length} 篇</span></h2>` +
        `<ul class="space-y-1">${lis}</ul></section>`
      );
    })
    .join("");

  const filterHint = filtered
    ? ` · 当前筛选 ${year ?? "全部"} 年${month ? ` ${month} 月` : ""}` +
      ` · <a href="/archives" class="underline" style="color:var(--link)">清除</a>`
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
              `<li><a href="/archives?year=${y.year}&month=${m.month}" class="flex items-center justify-between text-xs transition hover:underline" style="color:${mColor}">` +
              `${m.month} 月<span class="opacity-60">${m.count}</span></a></li>`
            );
          })
          .join("");
        return (
          `<div><a href="/archives?year=${y.year}" class="flex items-center justify-between text-sm font-semibold transition hover:underline" style="color:${yColor}">` +
          `${y.year}<span class="text-xs font-normal" style="color:var(--muted)">${y.total}</span></a>` +
          `<ul class="mt-1 space-y-0.5 pl-3">${months}</ul></div>`
        );
      })
      .join("") +
    `</aside>`;

  const main =
    `<div class="grid gap-8 lg:grid-cols-[1fr_240px]"><div>` +
    `<header class="mb-8">` +
    `<h1 class="flex items-center gap-2 text-3xl font-bold text-[var(--text)]">${CALENDAR_DAYS_SVG}文章归档</h1>` +
    `<p class="mt-2 text-sm" style="color:var(--muted)">共 <span style="color:var(--accent)">${total}</span> 篇文章${filterHint}</p>` +
    `</header>` +
    (items.length
      ? `<div class="space-y-8">${sections}</div>`
      : `<p class="rounded-2xl border p-10 text-center text-sm" style="border-color:var(--border);background:var(--surface);color:var(--muted)">这个时间段还没有文章。</p>`) +
    `</div>${aside}</div>`;

  const siteTitle = settings.siteTitle ?? "";

  const head =
    `<meta name="description" content="${esc(siteTitle)} 的全部文章按时间归档">` +
    `<meta property="og:url" content="${esc(ctx?.origin ?? "")}">` +
    `<meta property="og:site_name" content="${esc(siteTitle)}">` +
    `<meta property="og:locale" content="zh_CN">`;
  return {

    headTitle: `文章归档 - ${siteTitle}`,
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

async function feed(ctx: Ctx): Promise<string> {
  const settings = await getSettings();
  const feedItems = Math.min(Math.max(Number(settings.feedItems) || 20, 1), 100);
  // feedContent=full ships the body: listPosts strips content by default, so
  // the flag must reach the query, not just the renderer below.
  const full = settings.feedContent === "full";
  const [{ items }, { items: pageItems }] = await Promise.all([
    listPosts({ status: "published", limit: feedItems, pinned: false, full }),
    listPublishedPages({ limit: feedItems }),
  ]);
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
        const media = p.featuredImage ? `\n      ${R.mediaImageTag(p.featuredImage, ctx.origin)}` : "";
        return (
          `    <item>\n      <title>${escXml(p.title)}</title>\n      <link>${escXml(ctx.origin)}${escXml(p.url)}</link>` +
          `\n      <guid>${escXml(ctx.origin)}${escXml(p.url)}</guid>` +
          `\n      <pubDate>${(p.publishedAt ? new Date(p.publishedAt) : new Date()).toUTCString()}</pubDate>` +
          `\n      <description>${escXml(p.excerpt ?? "")}</description>${media}${cats}${extra}\n    </item>`
        );
      }),
    )
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escXml(settings.siteTitle ?? "")}</title>
    <link>${escXml(ctx.origin)}</link>
    <description>${escXml(settings.siteDescription ?? "")}</description>
    <language>zh-CN</language>
${xmlItems}
  </channel>
</rss>`;
}

async function robots(ctx: Ctx): Promise<string> {
  await ensurePluginsLoaded();
  const settings = await getSettings();
  const base = ctx.origin;
  if ((settings.seoRobots || "").toLowerCase().includes("noindex")) {
    const blocked = applyFilters<{ lines: string[]; base: string }>(HOOKS.robotsRules, {
      lines: ["User-agent: *", "Disallow: /"],
      base,
    });
    return `${blocked.lines.join("\n").trimEnd()}\n`;
  }
  const payload = applyFilters<{ lines: string[]; base: string }>(HOOKS.robotsRules, {
    lines: [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /api/",
      "Disallow: /search",
      "",
      `Sitemap: ${base}/sitemap.xml`,
    ],
    base,
  });
  return `${payload.lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
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
    name: settings.siteTitle || "oboext",
    short_name: (settings.siteTitle || "oboext").slice(0, 12),
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
  const [settings, site, themeSlug, recentResult] = await Promise.all([
    getNotFoundSettings(),
    getSettings(),
    getActiveThemeSlug(),
    listPosts({ status: "published", limit: 6 }),
  ]);
  const themed = themeSlug === "bluemix";
  let recent: Array<{ url: string; title: string }> = [];
  if (settings.showRecent) {
    recent = (recentResult.items || [])
      .slice(0, themed ? 5 : 6)
      .map((p: PostView) => ({ url: p.url, title: p.title }));
  }
  return {
    settings,
    recent,
    siteTitle: site.siteTitle ?? "",
    themeSlug,
    skin: themed ? bluemixNotFoundPage({ settings, recent }) : "",
  };
}

// ---------------------------------------------------- root catch-all resolver

function virtualRouteView(route: VirtualSiteRoute, ctx: Ctx) {
  const title = route.seoTitle || route.title;
  const desc = route.seoDescription ?? "";
  const kw = route.seoKeywords ?? "";
  const canonical = `${ctx.origin ?? ""}${route.path}`;
  const head =
    `<title>${R.esc(title)}</title>` +
    (desc ? `<meta name="description" content="${R.esc(desc)}">` : "") +
    (kw ? `<meta name="keywords" content="${R.esc(kw)}">` : "") +
    `<link rel="canonical" href="${R.esc(canonical)}">` +
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

function registerView(config: {
  path: string;
  nameRequired: boolean;
  passwordRequired: boolean;
  emailRequired: boolean;
  phoneRequired: boolean;
  emailVerify: boolean;
  phoneVerify: boolean;
  inviteOnly: boolean;
  captcha: { enabled: boolean; mode: "builtin" | "custom" | null };
}) {
  const head =
    `<title>注册账号</title>` +
    `<meta name="robots" content="noindex, nofollow">`;
  const field = (name: string, label: string, extra: string, required: boolean) =>
    `<div class="oboe-reg-fld">` +
    `<label>${R.esc(label)}${required ? "" : "（可选）"}</label>` +
    `<input class="oboe-reg-input" name="${name}" ${extra}${required ? " required" : ""}>` +
    `</div>`;
  const codeField = (name: string, sendAttr: string, label: string) =>
    `<div class="oboe-reg-fld">` +
    `<label>${R.esc(label)}</label>` +
    `<div class="oboe-reg-code">` +
    `<input class="oboe-reg-input" name="${name}" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="6 位验证码" required>` +
    `<button type="button" class="oboe-reg-send" ${sendAttr}>发送验证码</button>` +
    `</div></div>`;
  const captchaBlock = !config.captcha.enabled
    ? ""
    : config.captcha.mode === "custom"
      ? `<div class="oboe-reg-fld"><label>验证码</label>` +
        `<input class="oboe-reg-input" name="captchaToken" maxlength="200" autocomplete="off" placeholder="第三方验证码凭证" required></div>`
      : `<div class="oboe-reg-fld"><label>验证码</label>` +
        `<div class="oboe-reg-code">` +
        `<input class="oboe-reg-input" name="captcha" maxlength="4" autocomplete="off" spellcheck="false" placeholder="4 位字符" required style="max-width:120px;text-transform:uppercase;letter-spacing:.18em;">` +
        `<img data-oboe-reg-captcha-img src="/api/captcha/image" alt="验证码" title="看不清？点击刷新" style="height:38px;width:120px;cursor:pointer;border:1px solid var(--border-color,#d4d4d8);border-radius:8px;background:#eef2f7;">` +
        `</div></div>`;
  const main =
    `<style>` +
    `.oboe-reg{display:flex;flex-direction:column;gap:16px}` +
    `.oboe-reg-fld{display:flex;flex-direction:column;gap:6px}` +
    `.oboe-reg-fld label{font-size:13px;color:var(--text-color-2,#52525b)}` +
    `.oboe-reg-input{width:100%;box-sizing:border-box;padding:9px 12px;font-size:14px;color:var(--text-color,#18181b);background:var(--background-2,#fff);border:1px solid var(--border-color,#d4d4d8);border-radius:8px;outline:none}` +
    `.oboe-reg-input:focus{border-color:var(--primary-color,#4f46e5)}` +
    `.oboe-reg-code{display:flex;align-items:center;gap:8px}` +
    `.oboe-reg-send{flex-shrink:0;white-space:nowrap;padding:9px 12px;font-size:12.5px;color:var(--primary-color,#4f46e5);background:transparent;border:1px solid var(--border-color,#d4d4d8);border-radius:8px;cursor:pointer}` +
    `.oboe-reg-send:disabled{opacity:.5;cursor:not-allowed}` +
    `.oboe-reg-msg{min-height:18px;margin:0;font-size:13px;color:#dc2626}` +
    `.oboe-reg-submit{padding:11px;font-size:14px;font-weight:600;color:#fff;background:var(--primary-color,#4f46e5);border:none;border-radius:8px;cursor:pointer}` +
    `.oboe-reg-submit:disabled{opacity:.6;cursor:not-allowed}` +
    `.oboe-reg-note{margin:0;text-align:center;font-size:12px;color:var(--text-color-3,#a1a1aa)}` +
    `</style>` +
    `<div class="container-np" style="padding:40px 16px 64px;max-width:520px;margin-inline:auto">` +
    `<h1 style="font-size:26px;font-weight:700;margin-bottom:20px;color:var(--text-color,var(--foreground,#18181b))">注册账号</h1>` +
    `<form class="oboe-reg" data-oboe-reg` +
    ` data-name-required="${config.nameRequired ? "1" : "0"}"` +
    ` data-password-required="${config.passwordRequired ? "1" : "0"}"` +
    ` data-email-required="${config.emailRequired ? "1" : "0"}"` +
    ` data-phone-required="${config.phoneRequired ? "1" : "0"}"` +
    ` data-invite-only="${config.inviteOnly ? "1" : "0"}">` +
    field("name", "昵称", 'type="text" maxlength="32" autocomplete="username" placeholder="2~32 个字符，注册后用于登录"', config.nameRequired) +
    field("email", "邮箱", 'type="email" maxlength="120" autocomplete="email"', config.emailRequired) +
    (config.emailVerify ? codeField("emailCode", 'data-oboe-reg-send="email"', "邮箱验证码") : "") +
    field("phone", "手机号", 'type="tel" maxlength="20" autocomplete="tel" placeholder="中国大陆手机号或 + 开头的国际号码"', config.phoneRequired) +
    (config.phoneVerify ? codeField("phoneCode", 'data-oboe-reg-send="sms"', "手机验证码") : "") +
    (config.inviteOnly
      ? field("inviteCode", "邀请码", 'type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="请输入管理员发放的邀请码"', true)
      : "") +
    field("password", "密码", `type="password" maxlength="200" autocomplete="new-password" placeholder="${config.passwordRequired ? "至少 8 位" : "留空可免密注册，事后可补设"}"`, config.passwordRequired) +
    captchaBlock +
    `<p class="oboe-reg-msg" data-oboe-reg-msg></p>` +
    `<button type="submit" class="oboe-reg-submit" data-oboe-reg-submit>注 册</button>` +
    `<p class="oboe-reg-note">注册即代表同意站点规则 · <a href="/" style="color:var(--primary-color,#4f46e5)">返回首页</a></p>` +
    `</form>` +
    `</div>` +
    `<script src="${publicAssetHref("register.js")}" defer></script>`;
  return { head, main };
}

function userCenterView(route: VirtualSiteRoute, ctx: Ctx) {
  const title = route.seoTitle || route.title;
  const canonical = `${ctx.origin ?? ""}${route.path}`;
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

async function resolve(payload: { segments?: string[]; page?: number }, ctx: Ctx) {
  if (process.env.OBOEXT_DEBUG_RESOLVE) {
    const sm = (globalThis as any).__rosefd_signalMap as Map<string, unknown> | undefined;
    console.log("[resolve-debug] payload:", JSON.stringify(payload), "pathname:", ctx?.pathname,
      "signalMap.slug:", JSON.stringify((sm as any)?.get?.("slug")?.() ?? (sm as any)?.get?.("slug")),
      "mapSize:", sm?.size);
  }
  const raw = (payload.segments ?? []).map((s) => String(s));
  // Bots probe unknown paths far more than humans follow broken links, and
  // they come back. A confirmed miss is remembered for 60s so a repeat hit
  // skips the per-type probes and the notFound render's reads entirely;
  // invalidateContentCaches() drops these on every content write, so a page
  // created at a previously-missed URL is reachable at once.
  const missKey = `pathmiss:${raw.join("/")}`;
  if (raw.length && peekMemo<boolean>(missKey, PATH_MISS_TTL) === true) return null;
  const res = await resolveSitePath(raw);
  if (!res) {
    if (raw.length) await memoQuery(missKey, PATH_MISS_TTL, async () => true);
    const decoded = raw
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
      return {
        kind: "secret-entry",
        head: `<title>登录</title><meta name="robots" content="noindex, nofollow">`,
        main: secretEntryPageHtml({
          enabled: sec.captchaEnabled,
          mode: sec.captchaEnabled ? sec.captchaMode : null,
        }),
      };
    }
    const registerCfg = await getPublicRegisterConfig();
    if (
      registerCfg.enabled &&
      registerCfg.path === "/" + decoded.join("/")
    ) {
      return { kind: "register", ...registerView(registerCfg) };
    }
    if (decoded.length === 1 && decoded[0] === "me") {
      const me = ctx.user as any;
      const route = me
        ? await renderUserCenter(me)
        : await renderUserCenterGuest();
      return { kind: "usercenter", ...userCenterView(route, ctx) };
    }
    const virtual = await resolveVirtualRoute(decoded);
    if (!virtual) return null;
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
  const page = Math.max(1, Number(payload.page) || 1);
  let out: Record<string, any>;
  switch (res.kind) {
    case "home":
      out = await home();
      break;
    case "post":
      out = await postDetail({ slug: res.post.post.slug, preloaded: res.post }, ctx);
      break;
    case "page":
      out = await pageDetail({ slug: res.page.slug, preloaded: res.page }, ctx);
      break;
    case "blogIndex":
      out = await blogList({ page }, ctx);
      break;
    case "category":
      out = await categoryList({ slug: res.category.slug, page }, ctx);
      break;
    case "tag":
      out = await tagList({ slug: res.tag.slug, page }, ctx);
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
export async function warmEntityUrls(): Promise<string[]> {
  const [posts, cats, tags, cfg] = await Promise.all([
    listPosts({ status: "published", limit: 1 }),
    listCategories(),
    listTags(),
    getPermalinkConfig(),
  ]);
  return [
    posts.items[0]?.url,
    cats[0] ? categoryUrlFor(cfg, cats[0]) : undefined,
    tags[0] ? tagUrlFor(cfg, tags[0]) : undefined,
  ].filter((u): u is string => typeof u === "string" && u.startsWith("/"));
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
  archives,
  notFound,
  resolve,
  // admin screens (all per-request DB reads, session-gated)
  "admin.session": admin.adminSession,
  "admin.dashboard": admin.adminDashboard,
  "admin.posts": admin.adminPosts,
  "admin.post": admin.adminPost,
  "admin.pages": admin.adminPages,
  "admin.page": admin.adminPage,
  "admin.comments": admin.adminComments,
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
  "admin.maintenance": admin.adminMaintenance,
  "admin.security-logs": admin.adminSecurityLogs,
  "admin.icons": admin.adminIcons,
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
    };
  }
  const fn = (loaders as Record<string, (p: any, c: Ctx) => Promise<unknown>>)[key];
  if (!fn) throw new Error(`unknown loader: ${key}`);
  return fn(payload ?? {}, ctx);
}

/** Raw document builders for middleware-intercepted XML/txt routes. */
export const documents = { feed, robots, manifest };
