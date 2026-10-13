/**
 * Isomorphic view-model layer.
 *
 * Server: pages call `__rvLoad(key, payload)` (injected by rosefd.config.js),
 * which dispatches into this map with the per-request context bag.
 * Browser: the same helper GETs /api/data, whose handler calls dispatch().
 * Nothing here ever reaches the client bundle (api/data.rose is server-only).
 *
 * Every loader reads the live database on demand. No snapshots, no baking.
 */
import {
  archiveGroups,
  counts,
  getCategoryBySlug,
  getPost,
  getSettings,
  getTagBySlug,
  incrementViews,
  listCategories,
  listPosts,
  listPostComments,
  listTags,
  popularPosts,
  randomPosts,
  relatedPosts,
  relatedByTaxonomy,
  type PostView,
  type TaxRef,
} from "./queries.js";
import { getPermalinkConfig, blogIndexUrlFor, categoryUrlFor, tagUrlFor, resolveSitePath, paginate, type PermalinkConfig } from "./links.js";
import { resolveVirtualRoute, type VirtualSiteRoute } from "./virtual-routes.js";
import { resolveCommentConfig } from "./comments-config.js";
import { getPublishedPage, listPublishedPages } from "./pages.js";
import * as R from "./render.js";
import * as admin from "./admin-loaders.js";
import { getMenuByLocation } from "./menus.js";
import { getAreaWidgets } from "./widgets.js";
import { getActiveThemeSlug, getActiveThemeRenderConfig, getActiveThemeSettings, getThemeManifest } from "./themes.js";
import { themeToCss, resolveThemeConfig } from "./theme-tokens.js";
import { skyscraperBridgeRoot, skyscraperBridgeDark } from "./theme-bridge.js";
import { HOOKS, applyFilters } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { getNotFoundSettings } from "./not-found-config.js";
import { getPublicRegisterConfig } from "./members.js";
import { maintenanceGate, type MaintenanceSettings } from "./maintenance.js";
import { renderUserCenter, renderUserCenterGuest } from "./account.js";
import { loginCardHtml, secretEntryPageHtml } from "./login-card.js";
import { getAdminSecurity } from "./security.js";
import { getThemeChrome, publicAssetHref, bluemixNotFoundPage, type MenuItem } from "./theme-chrome.js";

export type Ctx = {
  query: URLSearchParams;
  origin: string;
  pathname: string;
  ip: string;
  ua: string;
  user?: unknown;
};

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

async function pluginFooterHtml(): Promise<string> {
  await ensurePluginsLoaded();
  const payload = applyFilters<{ html: string[] }>(HOOKS.footerHtml, { html: [] });
  const joined = payload.html.join("\n");
  if (!joined) return "";
  return `<div id="oboe-footer-hooks" aria-hidden="true" style="display:none">${joined}</div>`;
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

const pageNum = (v: unknown): number => Math.max(1, Number(v) || 1);

const sidebarFallback = (cfg: PermalinkConfig): R.SkyItem[] => [
  { id: "s1", label: "首页", url: "/" },
  { id: "s2", label: "所有文章", url: blogIndexUrlFor(cfg) },
];

async function chromeData(pathname: string) {
  const [
    settings,
    tagRows,
    stats,
    popular,
    cfg,
    sideMenu,
    themeSlug,
    renderConfig,
  ] = await Promise.all([
    getSettings(),
    listTags(),
    counts(),
    popularPosts(5),
    getPermalinkConfig(),
    getMenuByLocation("sidebar"),
    getActiveThemeSlug(),
    getActiveThemeRenderConfig(),
  ]);
  const [sideWidgets, footerWidgets] = await Promise.all([
    getAreaWidgets(themeSlug, "sidebar"),
    getAreaWidgets(themeSlug, "footer"),
  ]);
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
  const themeScripts =
    (themeSlug === "skyscraper" ? `<script src="/public/theme.js"></script>` : "") +
    (themeSlug !== "skyscraper" ? `<script src="${publicAssetHref("theme-pjax.js")}"></script>` : "") +
    (themeSlug === "bluemix" ? `<script src="${publicAssetHref("theme-bluemix.js")}"></script>` : "") +
    `<script src="${publicAssetHref("comments.js")}"></script>`;
  const headerMenu = await getMenuByLocation("header");
  const headerItems: MenuItem[] = (headerMenu?.items ?? []) as MenuItem[];

  const footerMenu = await getMenuByLocation("footer");
  const footerHtml = tc.footer(
    { ...settings, footerMenu: (footerMenu?.items ?? []) as MenuItem[] },
    R.widgetAreaHtml(footerWidgets, "sk-footer-widgets"),
  );
  return {
    siteTitle: settings.siteTitle ?? "",
    siteDescription: settings.siteDescription ?? "",
    varsHtml,
    themeSlug,
    cssHref: tc.cssHref(),
    themeScripts,
    bodyFix: tc.bodyFix(),
    headExtra: tc.headExtra(),
    navHtml: tc.nav({ ...settings, __pathname: pathname }, headerItems),
    bodyOpen: tc.bodyOpen({ ...settings, __pathname: pathname }, headerItems),
    bodyClose: tc.bodyClose(settings, footerHtml),
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
  const [d, cfg] = await Promise.all([chromeData(pathname), getPermalinkConfig()]);
  const isAdmin = pathname.indexOf("/admin") === 0;
  const blogIndex = blogIndexUrlFor(cfg);
  const pluginFooter = isAdmin ? "" : await pluginFooterHtml();
  const pluginHead =
    isAdmin || chromeSkipsHead(pathname, cfg)
      ? ""
      : await pluginHeadHtml(chromeHeadContext(pathname, d.siteTitle, origin, blogIndex));
  return {
    siteTitle: d.siteTitle,
    siteDescription: d.siteDescription,

    siteUrl: origin,
    themeHead: d.varsHtml + d.headExtra,
    themeSlug: d.themeSlug,
    cssHref: d.cssHref,
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

async function sideWidgetsFor(themeSlug: string): Promise<string> {

  if (themeSlug !== "codeman" && themeSlug !== "pseudolinear") return "";
  const wrap = themeSlug === "pseudolinear" ? "pl-side-stack" : "sk-widget-area";
  return R.widgetAreaHtml(await getAreaWidgets(themeSlug, "sidebar"), wrap);
}

async function bmixDrawerPosts(themeSlug: string): Promise<PostView[] | undefined> {
  if (themeSlug !== "bluemix") return undefined;
  const { items } = await listPosts({ status: "published", limit: 8 });
  return items;
}

async function defaultSidebarData(want: boolean, showCatIcons = false): Promise<{ posts: PostView[]; tags: TaxRef[]; cats: TaxRef[]; showCatIcons: boolean } | undefined> {
  if (!want) return undefined;
  const [{ items }, tagRows, catRows, cfg] = await Promise.all([
    listPosts({ status: "published", limit: 5 }),
    listTags(),
    listCategories(),
    getPermalinkConfig(),
  ]);
  return {
    posts: items,
    tags: tagRows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) })),
    cats: catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) })),
    showCatIcons,
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

async function home(ctx?: Ctx) {
  const [settings, themeSlug, cfg] = await Promise.all([
    getSettings(),
    getActiveThemeSlug(),
    getPermalinkConfig(),
  ]);

  const homeLimit = themeSlug === "pseudolinear" ? 30 : 12;
  const [all, popular, random, catRows] = await Promise.all([
    listPosts({ status: "published", limit: homeLimit }),
    listPosts({ status: "published", limit: 4, orderBy: "views" }),
    randomPosts(20),
    listCategories(),
  ]);
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const items = all.items;
  const tc = getThemeChrome(themeSlug);

  const homeHead = `<link rel="canonical" href="${R.esc(ctx?.origin ?? "")}">`;
  if (themeSlug !== "bluemix") {
    const tagRows = await listTags();
    const tags = tagRows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) }));

    const ts = themeSlug === "pseudolinear" || themeSlug === "default" ? await getActiveThemeSettings() : undefined;
    return {
      head: homeHead,
      main: tc.home({

        hero: themeSlug === "pseudolinear" ? items : items.slice(0, 4),
        latest: themeSlug === "pseudolinear" ? [] : items.slice(4, 12),
        liked: popular.items,
        random,
        cats,
        tags,
        total: all.total,
        widgets: await sideWidgetsFor(themeSlug),
        settings,
        themeSettings: ts,
      }),
    };
  }

  const ts = await getActiveThemeSettings();
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
  const [recent, ...sectionLists] = await Promise.all([
    listPosts({ status: "published", limit: Math.max(recentCount, bannerMax, 8) }),
    ...rows.map((r) => listPosts({ status: "published", categorySlug: r.category.slug, limit: catCount })),
  ]);
  const sections = rows
    .map((row, i) => ({ row, posts: (sectionLists[i]?.items ?? []) as any[] }))
    .filter((s) => s.posts.length > 0);

  const showRankings = ts.showRankings !== false;
  let rankings: { most_comments: any[]; most_likes: any[]; most_reads: any[] } | null = null;
  if (showRankings) {
    const [rc, rl, rv] = await Promise.all([
      listPosts({ status: "published", orderBy: "comments", limit: 3, pinned: false }),
      listPosts({ status: "published", orderBy: "likes", limit: 3, pinned: false }),
      listPosts({ status: "published", orderBy: "views", limit: 3, pinned: false }),
    ]);
    rankings = {
      most_comments: rc.items.map(bmToRankPost),
      most_likes: rl.items.map(bmToRankPost),
      most_reads: rv.items.map(bmToRankPost),
    };
  }
  const rankOrder = bmRankOrderFrom(ts.rankOrder);
  const rankTabs = {
    labels: {
      most_comments: bmStrOr(ts.rankLabelComments, "热评文章"),
      most_likes: bmStrOr(ts.rankLabelLikes, "大家喜欢"),
      most_reads: bmStrOr(ts.rankLabelReads, "阅读最多"),
    },
    order: rankOrder,
    defaultTab: bmRankDefaultFrom(ts.rankOrder, rankOrder[0]),
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
    }),
  };
}

async function blogList(payload: { page?: number }, ctx?: Ctx) {
  const [settings, themeSlug, cfg, catRows, all] = await Promise.all([
    getSettings(),
    getActiveThemeSlug(),
    getPermalinkConfig(),
    listCategories(),
    listPosts({ status: "published", limit: 5, orderBy: "views" }),
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
  const ts = await getActiveThemeSettings();
  const tc = getThemeChrome(themeSlug);

  const siteTitle = settings.siteTitle ?? "";
  const seoTitle = `文章 - ${siteTitle}`;
  const blogUrl = `${ctx?.origin ?? ""}${blogIndex}`;
  return {
    headTitle: seoTitle,
    head:
      `<link rel="canonical" href="${R.esc(blogUrl)}">` +
      `<meta property="og:title" content="${R.esc(seoTitle)}">` +
      `<meta property="og:url" content="${R.esc(blogUrl)}">` +
      `<meta name="twitter:title" content="${R.esc(seoTitle)}">`,
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
      widgets: await sideWidgetsFor(themeSlug),
      drawerPosts: await bmixDrawerPosts(themeSlug),
      sidebarData: await defaultSidebarData(themeSlug === "default", ts.useCustomIcons === true),
      settings,
      themeSettings: ts,

      total,
    }),
  };
}

async function categoryList(payload: { slug: string; page?: number }, ctx: Ctx) {
  const page = pageNum(payload.page);
  const [category, settings, cfg, themeSlug, catRows] = await Promise.all([
    getCategoryBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
    getActiveThemeSlug(),
    listCategories(),
  ]);
  if (!category) return { notFound: true };

  const isSk = themeSlug === "skyscraper";
  const catPerPage = isSk ? settings.postsPerPage || 10 : themeSlug === "codeman" || themeSlug === "pseudolinear" ? 30 : 12;
  const { items, total } = await listPosts({
    status: "published",
    categorySlug: payload.slug,
    limit: catPerPage,
    offset: isSk ? (page - 1) * catPerPage : 0,
  });
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
  const ts = await getActiveThemeSettings();
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
      widgets: await sideWidgetsFor(themeSlug),
      drawerPosts: await bmixDrawerPosts(themeSlug),
      sidebarData: await defaultSidebarData(themeSlug === "default", ts.useCustomIcons === true),
      settings,
      themeSettings: ts,
      
      
      titleIcon: themeSlug === "bluemix"
        ? (ts.useCustomIcons !== false ? category.icon : null)
        : (ts.useCustomIcons === true ? category.icon : null),
      titleDesc: category.description || "",
    }),
  };
}

async function tagList(payload: { slug: string; page?: number }, ctx: Ctx) {
  const page = pageNum(payload.page);
  const [tag, settings, cfg, themeSlug, ts] = await Promise.all([
    getTagBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
    getActiveThemeSlug(),
    getActiveThemeSettings(),
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
      widgets: await sideWidgetsFor(themeSlug),
      drawerPosts: await bmixDrawerPosts(themeSlug),
      
      sidebarData: await defaultSidebarData(!isSk, ts.useCustomIcons === true),
      settings,
      themeSettings: ts,
    }),
  };
}

async function search(payload: { q?: string; page?: number; all?: boolean }, ctx?: Ctx) {
  const q = (payload.q ?? "").trim();
  const page = pageNum(payload.page);
  const cleaned = q;
  const settings0 = await getSettings();
  const themeSlug = await getActiveThemeSlug();
  
  
  
  
  
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
  const settings = await getSettings();
  const ts = await getActiveThemeSettings();
  
  
  const searchSiteTitle = settings.siteTitle ?? "";
  const searchHead =
    `<meta property="og:url" content="${R.esc(ctx?.origin ?? "")}">` +
    `<meta property="og:site_name" content="${R.esc(searchSiteTitle)}">` +
    `<meta property="og:locale" content="zh_CN">`;
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
      widgets: await sideWidgetsFor(themeSlug),
      drawerPosts: await bmixDrawerPosts(themeSlug),
      
      sidebarData: await defaultSidebarData(themeSlug === "default", ts.useCustomIcons === true),
      settings,
      themeSettings: ts,
      emptyHint: isBm && !cleaned ? "输入关键词，从右上角搜索框或导航搜索寻找内容。" : undefined,
    }),
  };
}

async function postDetail(payload: { slug: string }, ctx: Ctx) {
  const post = await getPost(payload.slug);
  if (!post) return { notFound: true };
  const themeSlug0 = await getActiveThemeSlug();
  
  
  const relatedN = themeSlug0 === "codeman" || themeSlug0 === "pseudolinear" ? 5 : 4;
  const [related, settings, items, themeSlug, popular, random, cfg] = await Promise.all([
    relatedPosts(post, relatedN),
    getSettings(),
    listPostComments(post.id, "post"),
    getActiveThemeSlug(),
    popularPosts(4),
    randomPosts(12),
    getPermalinkConfig(),
  ]);
  
  
  const relatedTaxonomy =
    themeSlug === "default" ? await relatedByTaxonomy(post.id, 4) : undefined;
  if (ctx.ip || ctx.ua) {
    try {
      await incrementViews(post.id, ctx.ip, ctx.ua);
    } catch {
      /* */
    }
  }
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
    defaultContent: config.defaultContent,
    me,
    items,
    avatar: config.avatar,
    config: { ...config },
  });
  const metaPayload = applyFilters<{ post: unknown; items: R.MetaItem[] }>(HOOKS.postMeta, {
    post: { ...post, plainText: R.blocksToPlainText(post.content) },
    items: [],
  });
  const headContext: HeadContext = {
    kind: "post",
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
  };
  const tc = getThemeChrome(themeSlug);
  
  
  const highlight = themeSlug === "skyscraper" || themeSlug === "bluemix";
  const bodyHtml = await R.buildPostBody(post, "post", highlight);
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
  
  const isDefault = themeSlug === "default";
  const [postBottom, sidebarWidgets, ts] = isDefault
    ? await Promise.all([
        R.widgetAreaHtml(await getAreaWidgets(themeSlug, "post-bottom"), "space-y-6"),
        R.widgetAreaHtml(await getAreaWidgets(themeSlug, "sidebar"), "space-y-6"),
        getActiveThemeSettings(),
      ])
    : ["", "", undefined];
  return {
    main: tc.postPage({
      post,
      bodyHtml,
      related,
      relatedTaxonomy,
      popular,
      random,
      commentsHtml,
      metaHtml,
      defMetaHtml,
      metaBadges: metaPayload.items.map((m) => m.value),
      tagsHtml,
      defTagsHtml,
      shareHtml,
      blogIndex: blogIndexUrlFor(cfg),
      widgets: await sideWidgetsFor(themeSlug),
      postBottom,
      sidebarWidgets,
      
      sidebarData: isDefault ? await defaultSidebarData(true, ts?.useCustomIcons === true) : undefined,
      settings,
      canonical: `${ctx.origin}${post.url}`,
    }),
    head:
      R.postHead(post, settings.siteTitle ?? "", settings.siteDescription ?? "", ctx.origin) +
      (await pluginHeadHtml(headContext)),
  };
}

async function pageDetail(payload: { slug: string }, ctx: Ctx) {
  const page = await getPublishedPage(payload.slug);
  if (!page) return { notFound: true };
  
  const recentLimit = (await getActiveThemeSlug()) === "bluemix" ? 4 : 5;
  const [settings, recent, items, themeSlug] = await Promise.all([
    getSettings(),
    listPosts({ status: "published", limit: recentLimit }),
    listPostComments(page.id, "page"),
    getActiveThemeSlug(),
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
    defaultContent: config.defaultContent,
    me,
    items,
    avatar: config.avatar,
    config: { ...config },
  });
  const headContext: HeadContext = {
    kind: "page",
    siteTitle: settings.siteTitle ?? "",
    siteUrl: ctx.origin,
    title: page.seoTitle || page.title,
    description: page.seoDescription || page.excerpt || settings.siteDescription || "",
    image: page.featuredImage || undefined,
    publishedAt: page.publishedAt ? new Date(page.publishedAt).toISOString() : null,
    updatedAt: page.updatedAt ? new Date(page.updatedAt).toISOString() : null,
    url: `${ctx.origin}${page.url}`,
    breadcrumbs: [
      { label: "首页", href: "/" },
      { label: page.title, href: page.url },
    ],
  };
  const tc = getThemeChrome(themeSlug);
  
  const highlight = themeSlug === "skyscraper" || themeSlug === "bluemix";
  return {
    main: tc.pagePage({
      page,
      bodyHtml: await R.buildPostBody(page, "page", highlight),
      recent: recent.items,
      commentsHtml,
      
      widgets: await sideWidgetsFor(themeSlug),
    }),
    head:
      R.pageHead(page, settings.siteTitle ?? "", settings.siteDescription ?? "", ctx.origin) +
      (await pluginHeadHtml(headContext)),
  };
}

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
  const [settings, index] = await Promise.all([getSettings(), archiveGroups()]);
  const { total } = await listPosts({ status: "published", limit: 1, pinned: false });
  const filtered = !!(year || month);

  const { items } = await listPosts({
    status: "published",
    year: year || undefined,
    month: month && month >= 1 && month <= 12 ? month : undefined,
    limit: 1000,
    pinned: false,
  });

  
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
  const cleaned = q.trim();
  if (!cleaned) return null;
  const { items, total } = await listPosts({
    status: "published",
    search: cleaned,
    limit: 20,
  });
  return total === 1 && items[0]?.url ? items[0].url : null;
}

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
  const [{ items }, { items: pageItems }] = await Promise.all([
    listPosts({ status: "published", limit: feedItems, pinned: false }),
    listPublishedPages({ limit: feedItems }),
  ]);
  const full = settings.feedContent === "full";
  const cdata = (html: string) =>
    `<![CDATA[${html.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
  const xmlItems = (
    await Promise.all(
      [...items, ...pageItems].map(async (p) => {
        const kind = "author" in p ? "post" : "page";
        const extra = full
          ? `\n      <content:encoded>${cdata(await R.buildPostBody(p, kind))}</content:encoded>`
          : "";
        return (
          `    <item>\n      <title>${escXml(p.title)}</title>\n      <link>${escXml(ctx.origin)}${escXml(p.url)}</link>` +
          `\n      <guid>${escXml(ctx.origin)}${escXml(p.url)}</guid>` +
          `\n      <pubDate>${(p.publishedAt ? new Date(p.publishedAt) : new Date()).toUTCString()}</pubDate>` +
          `\n      <description>${escXml(p.excerpt ?? "")}</description>${extra}\n    </item>`
        );
      }),
    )
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
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
  const [settings, site, themeSlug] = await Promise.all([
    getNotFoundSettings(),
    getSettings(),
    getActiveThemeSlug(),
  ]);
  const themed = themeSlug === "bluemix";
  let recent: Array<{ url: string; title: string }> = [];
  if (settings.showRecent) {
    const result = await listPosts({ status: "published", limit: themed ? 5 : 6 });
    recent = (result.items || []).map((p: PostView) => ({ url: p.url, title: p.title }));
  }
  return {
    settings,
    recent,
    siteTitle: site.siteTitle ?? "",
    themeSlug,
    skin: themed ? bluemixNotFoundPage({ settings, recent }) : "",
  };
}

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
    `<script src="/public/register.js" defer></script>`;
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

async function resolve(payload: { segments?: string[]; page?: number }, ctx: Ctx) {
  const raw = (payload.segments ?? []).map((s) => String(s));
  const res = await resolveSitePath(raw);
  if (!res) {
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
        main: secretEntryPageHtml(),
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
      out = await postDetail({ slug: res.post.slug }, ctx);
      break;
    case "page":
      out = await pageDetail({ slug: res.page.slug }, ctx);
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
  return { kind: res.kind === "blogIndex" ? "blog" : res.kind, ...out };
}

async function loginCard() {
  return { html: loginCardHtml() };
}

export const loaders = {
  chrome,
  loginCard,
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
  if (key === "chrome" && ctx.pathname && ctx.pathname.indexOf("/admin") === 0) {
    return {
      siteTitle: "管理后台",
      siteDescription: "",
      siteUrl: "",
      themeHead: "",
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

