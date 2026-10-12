/**
 * Isomorphic view-model layer.
 *
 * Server: pages call `__rvLoad(key, payload)` (injected by rosezm.config.js),
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
  type PostView,
} from "./queries.js";
import { getPermalinkConfig, blogIndexUrlFor, categoryUrlFor, tagUrlFor } from "./links.js";
import { resolveCommentConfig } from "./comments-config.js";
import { getPublishedPage } from "./pages.js";
import * as R from "./render.js";
import * as admin from "./admin-loaders.js";
import { getMenuByLocation } from "./menus.js";
import { getAreaWidgets } from "./widgets.js";
import { getActiveThemeSlug, getActiveThemeRenderConfig, getActiveThemeSettings, getThemeManifest } from "./themes.js";
import { themeToCss } from "./theme-tokens.js";
import { skyscraperBridgeRoot, skyscraperBridgeDark } from "./theme-bridge.js";
import { HOOKS, applyFilters } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { getNotFoundSettings } from "./not-found-config.js";
import { getThemeChrome, type MenuItem } from "./theme-chrome.js";

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

/** Collect plugin markup injected before </body> (footer.html filter). */
async function pluginFooterHtml(): Promise<string> {
  await ensurePluginsLoaded();
  const payload = applyFilters<{ html: string[] }>(HOOKS.footerHtml, { html: [] });
  return payload.html.join("\n");
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
 */
function chromeHeadContext(pathname: string, siteTitle: string, origin: string): HeadContext {
  if (pathname === "/") return { kind: "home", siteTitle, siteUrl: origin };
  if (pathname === "/blog" || pathname === "/blog/")
    return {
      kind: "archive",
      siteTitle,
      siteUrl: origin,
      title: "所有文章",
      breadcrumbs: [
        { label: "首页", href: "/" },
        { label: "文章", href: "/blog" },
      ],
    };
  if (pathname.indexOf("/search") === 0)
    return { kind: "search", siteTitle, siteUrl: origin, title: "搜索" };
  return { kind: "archive", siteTitle, siteUrl: origin };
}

/**
 * Entity/taxonomy detail pages build head nodes in their own loader (with
 * the entity's title/dates/breadcrumbs), so the chrome-level pass skips
 * them to avoid double emission.
 */
function chromeSkipsHead(pathname: string): boolean {
  return (
    (pathname.indexOf("/blog/") === 0 && pathname !== "/blog/") ||
    (pathname.indexOf("/pages/") === 0 && pathname !== "/pages/")
  );
}

const pageNum = (v: unknown): number => Math.max(1, Number(v) || 1);

const SIDEBAR_FALLBACK: R.SkyItem[] = [
  { id: "s1", label: "首页", url: "/" },
  { id: "s2", label: "所有文章", url: "/blog" },
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
    sideMenu && sideMenu.items.length ? (sideMenu.items as R.SkyItem[]) : SIDEBAR_FALLBACK;
  const tc = getThemeChrome(themeSlug);
  const headerMenu = await getMenuByLocation("header");
  const headerItems: MenuItem[] = (headerMenu?.items ?? []) as MenuItem[];
  const footerHtml = tc.footer(
    settings,
    R.widgetAreaHtml(footerWidgets, "sk-footer-widgets"),
  );
  return {
    siteTitle: settings.siteTitle ?? "",
    siteDescription: settings.siteDescription ?? "",
    varsHtml,
    themeSlug,
    cssHref: tc.cssHref(),
    bodyFix: tc.bodyFix(),
    headExtra: tc.headExtra(),
    navHtml: tc.nav(settings, headerItems),
    bodyOpen: tc.bodyOpen(settings, headerItems),
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
  const d = await chromeData(pathname);
  const isAdmin = pathname.indexOf("/admin") === 0;
  const pluginFooter = isAdmin ? "" : await pluginFooterHtml();
  const pluginHead =
    isAdmin || chromeSkipsHead(pathname)
      ? ""
      : await pluginHeadHtml(chromeHeadContext(pathname, d.siteTitle, origin));
  return {
    siteTitle: d.siteTitle,
    siteDescription: d.siteDescription,
    themeHead: d.varsHtml + d.headExtra,
    themeSlug: d.themeSlug,
    cssHref: d.cssHref,
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

async function home() {
  const [all, popular, random, catRows, cfg, settings, themeSlug] = await Promise.all([
    listPosts({ status: "published", limit: 12 }),
    listPosts({ status: "published", limit: 4, orderBy: "views" }),
    randomPosts(20),
    listCategories(),
    getPermalinkConfig(),
    getSettings(),
    getActiveThemeSlug(),
  ]);
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const items = all.items;
  const tc = getThemeChrome(themeSlug);

  if (themeSlug !== "bluemix") {
    return {
      main: tc.home({
        hero: items.slice(0, 4),
        latest: items.slice(4, 12),
        liked: popular.items,
        random,
        cats,
        settings,
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
    listPosts({ status: "published", limit: Math.max(recentCount, bannerMax, 8), context: "home" }),
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

async function blogList(payload: { page?: number }) {
  const [settings, themeSlug] = await Promise.all([getSettings(), getActiveThemeSlug()]);
  const perPage = settings.postsPerPage || 10;
  const page = pageNum(payload.page);
  const { items, total } = await listPosts({
    status: "published",
    limit: perPage,
    offset: (page - 1) * perPage,
  });
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const tc = getThemeChrome(themeSlug);
  return {
    headTitle: `全部文章 - ${settings.siteTitle ?? ""}`,
    main: tc.listPage({
      title: "全部文章",
      sub: `共 ${total} 篇 · 第 ${page}/${totalPages} 页`,
      items,
      page,
      totalPages,
      hrefFor: (p) => (p === 1 ? "/blog" : `/blog?page=${p}`),
    }),
  };
}

async function categoryList(payload: { slug: string; page?: number }, ctx: Ctx) {
  const page = pageNum(payload.page);
  const [category, settings, cfg, themeSlug] = await Promise.all([
    getCategoryBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
    getActiveThemeSlug(),
  ]);
  if (!category) return { notFound: true };
  const perPage = settings.postsPerPage || 10;
  const { items, total } = await listPosts({
    status: "published",
    categorySlug: payload.slug,
    limit: perPage,
    offset: (page - 1) * perPage,
  });
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const sub =
    (category.description ? `${category.description} · ` : "") +
    `共 ${total} 篇 · 第 ${page}/${totalPages} 页`;
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
  const tc = getThemeChrome(themeSlug);
  return {
    headTitle: `分类：${category.name} - ${settings.siteTitle ?? ""}`,
    pluginHead,
    main: tc.listPage({
      title: `分类：${category.name}`,
      sub,
      items,
      page,
      totalPages,
      hrefFor: (n) => `/blog/category/${category.slug}?page=${n}`,
    }),
  };
}

async function tagList(payload: { slug: string; page?: number }, ctx: Ctx) {
  const page = pageNum(payload.page);
  const [tag, settings, cfg, themeSlug] = await Promise.all([
    getTagBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
    getActiveThemeSlug(),
  ]);
  if (!tag) return { notFound: true };
  const perPage = settings.postsPerPage || 10;
  const { items, total } = await listPosts({
    status: "published",
    tagSlug: payload.slug,
    limit: perPage,
    offset: (page - 1) * perPage,
  });
  const totalPages = Math.max(1, Math.ceil(total / perPage));
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
  return {
    headTitle: `标签：#${tag.name} - ${settings.siteTitle ?? ""}`,
    pluginHead,
    main: tc.listPage({
      title: `标签：#${tag.name}`,
      sub: `共 ${total} 篇 · 第 ${page}/${totalPages} 页`,
      items,
      page,
      totalPages,
      hrefFor: (n) => `/blog/tag/${tag.slug}?page=${n}`,
    }),
  };
}

async function search(payload: { q?: string; page?: number; all?: boolean }) {
  const q = (payload.q ?? "").trim();
  const page = pageNum(payload.page);
  const perPage = 20;
  const cleaned = q;
  const { items, total } = cleaned
    ? await listPosts({
        status: "published",
        search: cleaned,
        limit: perPage,
        offset: (page - 1) * perPage,
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
  return {
    headTitle: `搜索 - ${settings.siteTitle ?? ""}`,
    main: getThemeChrome(await getActiveThemeSlug() || "skyscraper").listPage({
      title: cleaned ? `搜索：“${cleaned}”` : "搜索",
      sub: cleaned ? `共 ${total} 条结果 · 第 ${page}/${totalPages} 页` : "在顶部搜索框输入关键词",
      items,
      page,
      totalPages,
      hrefFor,
      showPager: total > perPage,
      extra,
    }),
  };
}

async function postDetail(payload: { slug: string }, ctx: Ctx) {
  const post = await getPost(payload.slug);
  if (!post) return { notFound: true };
  const [related, settings, items, themeSlug, popular, random] = await Promise.all([
    relatedPosts(post, 4),
    getSettings(),
    listPostComments(post.id, "post"),
    getActiveThemeSlug(),
    popularPosts(4),
    randomPosts(12),
  ]);
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
  const commentsHtml = R.commentsSection({
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
    config,
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
  const bodyHtml = R.buildPostBody(post);
  const metaHtml = metaPayload.items.length
    ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--muted)">${metaPayload.items.map((m) => `<span>${R.esc(m.label)}：${R.esc(m.value)}</span>`).join("")}</div>`
    : "";
  const tagsHtml = (post.tags || []).length
    ? `<div style="margin-top:32px;display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid var(--border);padding-top:24px">${(post.tags || []).map((t) => `<a href="${R.esc(t.url || `/blog/tag/${t.slug}`)}" style="font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--border);padding:4px 12px;border-radius:9999px">#${R.esc(t.name)}</a>`).join("")}</div>`
    : "";
  const shareHtml = R.shareBar(post);
  return {
    main: tc.postPage({ post, bodyHtml, related, popular, random, commentsHtml, metaHtml, tagsHtml, shareHtml }),
    head:
      R.postHead(post, settings.siteTitle ?? "", settings.siteDescription ?? "", ctx.origin) +
      (await pluginHeadHtml(headContext)),
  };
}

async function pageDetail(payload: { slug: string }, ctx: Ctx) {
  const page = await getPublishedPage(payload.slug);
  if (!page) return { notFound: true };
  const [settings, recent, items, themeSlug] = await Promise.all([
    getSettings(),
    listPosts({ status: "published", limit: 5 }),
    listPostComments(page.id, "page"),
    getActiveThemeSlug(),
  ]);
  const config = resolveCommentConfig(settings);
  const u = ctx.user as { id?: number; name?: string; email?: string } | undefined;
  const me = u && u.id ? { id: u.id, name: u.name ?? "", email: u.email ?? "" } : null;
  const commentsHtml = R.commentsSection({
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
    config,
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
    author: page.author?.name,
    url: `${ctx.origin}${page.url}`,
    breadcrumbs: [
      { label: "首页", href: "/" },
      { label: page.title, href: page.url },
    ],
  };
  const tc = getThemeChrome(themeSlug);
  return {
    main: tc.pagePage({ page, bodyHtml: R.buildPostBody(page), recent: recent.items, commentsHtml }),
    head:
      R.pageHead(page, settings.siteTitle ?? "", settings.siteDescription ?? "", ctx.origin) +
      (await pluginHeadHtml(headContext)),
  };
}

async function archives(payload: { year?: number; month?: number }) {
  const year = Number(payload.year) || 0;
  const month = Number(payload.month) || 0;
  const esc = R.esc;
  const [settings, themeSlug] = await Promise.all([getSettings(), getActiveThemeSlug()]);
  const siteTitle = settings.siteTitle ?? "";
  const tc = getThemeChrome(themeSlug);
  if (year && month >= 1 && month <= 12) {
    const { items } = await listPosts({
      status: "published",
      year,
      month,
      limit: 1000,
      pinned: false,
    });
    return {
      headTitle: `${year} 年 ${month} 月 - ${siteTitle}`,
      main: tc.listPage({
        title: `${year} 年 ${month} 月`,
        sub: `共 ${items.length} 篇`,
        items,
        page: 1,
        totalPages: 1,
        hrefFor: () => "#",
        showPager: false,
        extra: `<div style="margin-bottom:24px"><a href="/archives?year=${year}">← ${year} 年</a> &nbsp; <a href="/archives">全部归档</a></div>`,
      }),
    };
  }
  if (year) {
    const { items } = await listPosts({
      status: "published",
      year,
      limit: 1000,
      pinned: false,
    });
    const groups = new Map<number, PostView[]>();
    for (const it of items) {
      const m = it.publishedAt ? new Date(it.publishedAt).getMonth() + 1 : 0;
      const list = groups.get(m) ?? [];
      list.push(it);
      groups.set(m, list);
    }
    const sections = [...groups.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([m, list]) => {
        const lis = list
          .map(
            (p) =>
              `<li style="padding:4px 0"><a href="${R.esc(p.url)}">${R.esc(p.title)}</a> <em style="color:var(--muted,#9aa3b2);font-size:12px">${
                p.publishedAt ? new Date(p.publishedAt).getDate() : ""
              } 日</em></li>`,
          )
          .join("");
        return `<section style="margin-bottom:24px"><h2 style="font-size:18px;font-weight:600;margin-bottom:8px">${year} 年 ${m} 月 <span style="color:var(--muted,#9aa3b2);font-size:14px">${list.length}</span></h2><ul style="list-style:none;padding:0;margin:0">${lis}</ul></section>`;
      })
      .join("");
    return {
      headTitle: `${year} 年 - ${siteTitle}`,
      main:
        `<div><h1 style="font-size:28px;font-weight:700;margin:0 0 8px">${year} 年</h1>` +
        `<p style="color:var(--muted,#9aa3b2);margin:0 0 24px;font-size:14px">共 ${items.length} 篇</p>` +
        `<div style="margin-bottom:24px"><a href="/archives">← 返回归档</a></div>${sections}</div>`,
    };
  }
  const groups = await archiveGroups();
  const items = groups
    .map(
      (y) =>
        `<section style="margin-bottom:24px"><h2 style="font-size:20px;font-weight:600;margin-bottom:8px">${y.year} <span style="color:var(--muted,#9aa3b2);font-size:14px">${y.total}</span></h2><ul style="list-style:none;padding:0;margin:0">` +
        y.months
          .map(
            (m) =>
              `<li style="padding:4px 0"><a href="/archives?year=${y.year}&month=${m.month}">${y.year} 年 ${m.month} 月</a> <em style="color:var(--muted,#9aa3b2);font-size:12px">${m.count}</em></li>`,
          )
          .join("") +
        `</ul></section>`,
    )
    .join("");
  return {
    headTitle: `文章归档 - ${siteTitle}`,
    main:
      `<div><h1 style="font-size:28px;font-weight:700;margin:0 0 8px">文章归档</h1>` +
      `<p style="color:var(--muted,#9aa3b2);margin:0 0 24px;font-size:14px">${esc("按年月浏览全部文章")}</p>${items}</div>`,
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
  const { items } = await listPosts({ status: "published", limit: feedItems, pinned: false });
  const full = settings.feedContent === "full";
  const cdata = (html: string) =>
    `<![CDATA[${html.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
  const xmlItems = items
    .map((p) => {
      const extra = full ? `\n      <content:encoded>${cdata(R.buildPostBody(p))}</content:encoded>` : "";
      return (
        `    <item>\n      <title>${escXml(p.title)}</title>\n      <link>${escXml(ctx.origin)}${escXml(p.url)}</link>` +
        `\n      <guid>${escXml(ctx.origin)}${escXml(p.url)}</guid>` +
        `\n      <pubDate>${(p.publishedAt ? new Date(p.publishedAt) : new Date()).toUTCString()}</pubDate>` +
        `\n      <description>${escXml(p.excerpt ?? "")}</description>${extra}\n    </item>`
      );
    })
    .join("\n");
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

async function notFound(_p: unknown, _ctx: Ctx) {
  const settings = await getNotFoundSettings();
  let recent: Array<{ url: string; title: string }> = [];
  if (settings.showRecent) {
    const result = await listPosts({ status: "published", limit: 6 });
    recent = (result.items || []).map((p: PostView) => ({ url: p.url, title: p.title }));
  }
  return { settings, recent };
}

export const loaders = {
  chrome,
  home,
  blog: blogList,
  category: categoryList,
  tag: tagList,
  search,
  post: postDetail,
  page: pageDetail,
  archives,
  notFound,
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
  "admin.menu-settings": admin.adminMenuSettings,
  "admin.taxonomies": admin.adminTaxonomies,
  "admin.users": admin.adminUsers,
  "admin.settings": admin.adminSettings,
  "notFoundConfig": admin.notFoundConfig,
};
export type LoaderKey = keyof typeof loaders;

/** Server-only dispatch used by pages and by /api/data. */
export async function dispatch(key: string, payload: any, ctx: Ctx): Promise<unknown> {
  if (key === "chrome" && ctx.pathname && ctx.pathname.indexOf("/admin") === 0) {
    return {
      siteTitle: "管理后台",
      siteDescription: "",
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
export const documents = { feed, robots };

/**
 * Standalone 404 document. The framework renders pages/404.rose only for
 * UNMATCHED routes; a matched dynamic route whose entity is missing cannot
 * change its HTTP status from inside the component, so the middleware asks
 * for this and returns it with a real 404. It reuses the same chrome, so it
 * stays pixel-identical (minus client routing - a 404 is a dead end).
 */
export async function notFoundDocument(ctx: Ctx): Promise<string> {
  const c = await chromeData((ctx && ctx.pathname) || "/");
  const pluginFooter = await pluginFooterHtml();
  const siteSettings = await getSettings();
  const siteTitle = siteSettings.siteTitle ?? "";
  const nf = await getNotFoundSettings();
  const lines = (nf.message || "").split(/\n+/).map(l => l.trim()).filter(Boolean);
  const msgHtml = lines.map(l => `<p>${R.esc(l)}</p>`).join("");
  const searchHtml = nf.showSearch
    ? `<form class="nf-search" action="/search" method="get"><input type="search" name="q" placeholder="搜索文章…" aria-label="搜索文章"><button type="submit"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> 搜索</button></form>`
    : "";
  let recentHtml = "";
  if (nf.showRecent) {
    const result = await listPosts({ status: "published", limit: 6 });
    const items = result.items || [];
    if (items.length > 0) {
      const lis = items.map((p: PostView) => `<li><a href="${R.esc(p.url)}">${R.esc(p.title)}</a></li>`).join("");
      recentHtml = `<div class="nf-recent"><h2>最近文章</h2><ul>${lis}</ul></div>`;
    }
  }
  const card =
    `<div class="nf-wrap"><div class="nf-box"><span class="nf-icon"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16.24 7.76l-2.12 6.12-6.12 2.12 2.12-6.12z"/></svg></span>` +
    `<h1 class="nf-title">${R.esc(nf.title)}</h1>` +
    `<div class="nf-message">${msgHtml}</div>` +
    searchHtml +
    `<div class="nf-home"><a href="/"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> 返回首页</a></div>` +
    recentHtml +
    `</div></div>`;
  const nfStyle = `.nf-wrap{display:flex;justify-content:center;padding:4rem 1rem}.nf-box{width:100%;max-width:36rem;text-align:center}.nf-icon{display:inline-flex;align-items:center;justify-content:center;width:4rem;height:4rem;border-radius:9999px;border:1px solid var(--primary-color,var(--accent,#1f8bff));color:var(--primary-color,var(--accent,#1f8bff));margin-bottom:1.5rem}.nf-title{font-size:1.875rem;font-weight:700;color:var(--text-color,var(--text,#1f2937));margin:0}.nf-message{margin-top:.75rem;font-size:.875rem;line-height:1.5;color:var(--muted-color,var(--muted,#6b7280))}.nf-message p{margin:.25rem 0}.nf-search{display:flex;max-width:28rem;margin:1.75rem auto 0;gap:.5rem}.nf-search input{flex:1;height:2.5rem;border-radius:9999px;border:1px solid var(--border-color,var(--border,#e5e7eb));background:var(--surface-color,var(--surface,#fff));color:var(--text-color,var(--text,#1f2937));padding:0 1rem;font-size:.875rem;outline:none}.nf-search button{display:inline-flex;align-items:center;gap:.375rem;height:2.5rem;padding:0 1.25rem;border-radius:9999px;background:var(--primary-color,var(--accent,#1f8bff));color:#fff;font-size:.875rem;font-weight:500;border:none;cursor:pointer}.nf-home{margin-top:1.5rem}.nf-home a{display:inline-flex;align-items:center;gap:.375rem;font-size:.875rem;font-weight:500;color:var(--primary-color,var(--accent,#1f8bff));text-decoration:none}.nf-recent{margin-top:2.5rem;border-radius:1rem;border:1px solid var(--border-color,var(--border,#e5e7eb));background:var(--surface-color,var(--surface,#fff));padding:1.5rem;text-align:left}.nf-recent h2{font-size:.875rem;font-weight:600;margin:0 0 .75rem}.nf-recent ul{list-style:none;padding:0;margin:0}.nf-recent li{margin-bottom:.5rem}.nf-recent a{display:block;font-size:.875rem;color:var(--muted-color,var(--muted,#6b7280));text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>404 - ${R.esc(siteTitle)}</title>` +
    `<meta name="robots" content="noindex">` +
    `<link rel="stylesheet" href="/public/theme.css">${c.varsHtml}<style>${nfStyle}</style><link rel="icon" href="data:,">` +
    `</head><body><div class="th-skyscraper">${c.navHtml}` +
    `<div class="sk-body"><main id="sk-main"><div class="container"><div class="main-column"><div class="sk-frame">${card}</div></div>` +
    `<aside class="sidebar-column with-separate-line"><div class="sidebar-content">${c.asideHtml}</div></aside>` +
    `</div></main></div>${c.footerHtml}${pluginFooter}</div></body></html>`
  );
}
