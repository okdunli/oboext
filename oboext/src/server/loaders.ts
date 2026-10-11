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
import { getPermalinkConfig, blogIndexUrlFor, categoryUrlFor, tagUrlFor, pageUrlFor } from "./links.js";
import { resolveCommentConfig } from "./comments-config.js";
import { getPublishedPage, listPublishedPages } from "./pages.js";
import * as R from "./render.js";
import * as admin from "./admin-loaders.js";
import { getMenuByLocation } from "./menus.js";
import { getAreaWidgets } from "./widgets.js";
import { getActiveThemeSlug, getActiveThemeRenderConfig } from "./themes.js";
import { themeToCss } from "./theme-tokens.js";
import { HOOKS, applyFilters } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";

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
  const varsHtml =
    pathname.indexOf("/admin") === 0
      ? ""
      : `<style id="rv-theme-vars">:root{${themeToCss(renderConfig)}}</style>` +
        (typeof renderConfig.customCss === "string" && renderConfig.customCss
          ? `<style id="rv-theme-custom">${renderConfig.customCss}</style>`
          : "");
  const tags = tagRows.map((t) => ({ ...t, url: tagUrlFor(cfg, t) }));
  const menuItems: R.SkyItem[] =
    sideMenu && sideMenu.items.length ? (sideMenu.items as R.SkyItem[]) : SIDEBAR_FALLBACK;
  return {
    siteTitle: settings.siteTitle ?? "",
    siteDescription: settings.siteDescription ?? "",
    varsHtml,
    navHtml: R.topNav(settings),
    asideHtml:
      R.sidebarMenu(menuItems, pathname) +
      R.tagCloud(tags) +
      R.blogStats(stats) +
      R.popularWidget(popular) +
      R.widgetAreaHtml(sideWidgets, "sk-widget-area"),
    footerHtml: R.footerHtml(
      settings,
      R.widgetAreaHtml(footerWidgets, "sk-footer-widgets"),
    ),
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
    themeHead: d.varsHtml,
    nav: d.navHtml,
    aside: d.asideHtml,
    footer: d.footerHtml,
    pluginFooter,
    pluginHead,
  };
}

async function home() {
  const [all, popular, random, catRows, cfg] = await Promise.all([
    listPosts({ status: "published", limit: 12 }),
    listPosts({ status: "published", limit: 4, orderBy: "views" }),
    randomPosts(20),
    listCategories(),
    getPermalinkConfig(),
  ]);
  const cats = catRows.map((c) => ({ ...c, url: categoryUrlFor(cfg, c) }));
  const items = all.items;
  return {
    main: R.homeHtml({
      hero: items.slice(0, 4),
      latest: items.slice(4, 12),
      liked: popular.items,
      random,
      cats,
    }),
  };
}

async function blogList(payload: { page?: number }) {
  const settings = await getSettings();
  const perPage = settings.postsPerPage || 10;
  const page = pageNum(payload.page);
  const { items, total } = await listPosts({
    status: "published",
    limit: perPage,
    offset: (page - 1) * perPage,
  });
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  return {
    headTitle: `全部文章 - ${settings.siteTitle ?? ""}`,
    main: R.listPage({
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
  const [category, settings, cfg] = await Promise.all([
    getCategoryBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
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
  return {
    headTitle: `分类：${category.name} - ${settings.siteTitle ?? ""}`,
    pluginHead,
    main: R.listPage({
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
  const [tag, settings, cfg] = await Promise.all([
    getTagBySlug(payload.slug),
    getSettings(),
    getPermalinkConfig(),
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
  return {
    headTitle: `标签：#${tag.name} - ${settings.siteTitle ?? ""}`,
    pluginHead,
    main: R.listPage({
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
    main: R.listPage({
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
  const [related, settings, items] = await Promise.all([
    relatedPosts(post, 4),
    getSettings(),
    listPostComments(post.id, "post"),
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
  return {
    main: R.postPage(post, related, commentsHtml, metaPayload.items),
    head:
      R.postHead(post, settings.siteTitle ?? "", settings.siteDescription ?? "", ctx.origin) +
      (await pluginHeadHtml(headContext)),
  };
}

async function pageDetail(payload: { slug: string }, ctx: Ctx) {
  const page = await getPublishedPage(payload.slug);
  if (!page) return { notFound: true };
  const [settings, recent, items] = await Promise.all([
    getSettings(),
    listPosts({ status: "published", limit: 5 }),
    listPostComments(page.id, "page"),
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
  return {
    main: R.pagePage(page, recent.items, commentsHtml),
    head:
      R.pageHead(page, settings.siteTitle ?? "", settings.siteDescription ?? "", ctx.origin) +
      (await pluginHeadHtml(headContext)),
  };
}

async function archives(payload: { year?: number; month?: number }) {
  const year = Number(payload.year) || 0;
  const month = Number(payload.month) || 0;
  const esc = R.esc;
  const settings = await getSettings();
  const siteTitle = settings.siteTitle ?? "";
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
      main: R.listPage({
        title: `${year} 年 ${month} 月`,
        sub: `共 ${items.length} 篇`,
        items,
        page: 1,
        totalPages: 1,
        hrefFor: () => "#",
        showPager: false,
        extra: `<div class="sk-search-all"><a href="/archives?year=${year}">← ${year} 年</a> &nbsp; <a href="/archives">全部归档</a></div>`,
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
              `<li><a href="${R.esc(p.url)}">${R.esc(p.title)}</a> <em>${
                p.publishedAt ? new Date(p.publishedAt).getDate() : ""
              } 日</em></li>`,
          )
          .join("");
        return `<section class="sk-archive-year"><h2>${year} 年 ${m} 月 <span>${list.length}</span></h2><ul>${lis}</ul></section>`;
      })
      .join("");
    return {
      headTitle: `${year} 年 - ${siteTitle}`,
      main:
        `<section class="sk-section sk-list-page"><h1 class="title_style_01">${year} 年</h1>` +
        `<div class="sk-list-sub sk-muted">共 ${items.length} 篇</div>` +
        `<div class="sk-search-all"><a href="/archives">← 返回归档</a></div>${sections}</section>`,
    };
  }
  const groups = await archiveGroups();
  const items = groups
    .map(
      (y) =>
        `<section class="sk-archive-year"><h2>${y.year} <span>${y.total}</span></h2><ul>` +
        y.months
          .map(
            (m) =>
              `<li><a href="/archives?year=${y.year}&month=${m.month}">${y.year} 年 ${m.month} 月</a> <em>${m.count}</em></li>`,
          )
          .join("") +
        `</ul></section>`,
    )
    .join("");
  return {
    headTitle: `文章归档 - ${siteTitle}`,
    main:
      `<section class="sk-section sk-list-page"><h1 class="title_style_01">文章归档</h1>` +
      `<div class="sk-list-sub sk-muted">${esc("按年月浏览全部文章")}</div>${items}</section>`,
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
const day = (v: Date | string | null | undefined): string | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

async function sitemap(ctx: Ctx): Promise<string> {
  const [{ items }, categories, tags, pageRows, cfg] = await Promise.all([
    listPosts({ status: "published", limit: 10000, pinned: false }),
    listCategories(),
    listTags(),
    listPublishedPages({ limit: 10000 }),
    getPermalinkConfig(),
  ]);
  const base = ctx.origin;
  const blogIndex = blogIndexUrlFor(cfg);
  const urls: string[] = [
    `<url><loc>${escXml(base)}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
  ];
  if (blogIndex !== "/")
    urls.push(
      `<url><loc>${escXml(base)}${escXml(blogIndex)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    );
  for (const p of items)
    urls.push(
      `<url><loc>${escXml(base)}${escXml(p.url)}</loc>${
        day(p.updatedAt ?? p.publishedAt) ? `<lastmod>${day(p.updatedAt ?? p.publishedAt)}</lastmod>` : ""
      }<changefreq>weekly</changefreq><priority>0.8</priority></url>`,
    );
  for (const c of categories)
    urls.push(`<url><loc>${escXml(base)}${escXml(categoryUrlFor(cfg, c))}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
  for (const t of tags)
    urls.push(`<url><loc>${escXml(base)}${escXml(tagUrlFor(cfg, t))}</loc><changefreq>weekly</changefreq><priority>0.4</priority></url>`);
  for (const g of pageRows.items)
    urls.push(
      `<url><loc>${escXml(base)}${escXml(pageUrlFor(cfg, g))}</loc>${
        day(g.updatedAt ?? g.publishedAt) ? `<lastmod>${day(g.updatedAt ?? g.publishedAt)}</lastmod>` : ""
      }<changefreq>monthly</changefreq><priority>0.6</priority></url>`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join(
    "\n",
  )}\n</urlset>`;
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
export const documents = { sitemap, feed, robots };

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
  const settings = await getSettings();
  const title = settings.siteTitle ?? "";
  const card =
    '<section class="sk-section sk-list-page"><h1 class="title_style_01">404</h1>' +
    '<div class="sk-list-sub sk-muted">抱歉，您访问的内容不存在或已被移除。</div>' +
    '<div class="sk-search-all"><a href="/">← 返回首页</a> &nbsp; <a href="/blog">浏览所有文章</a></div></section>';
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>404 - ${R.esc(title)}</title>` +
    `<meta name="robots" content="noindex">` +
    `<link rel="stylesheet" href="/public/theme.css">${c.varsHtml}<link rel="icon" href="data:,">` +
    `</head><body><div class="th-skyscraper">${c.navHtml}` +
    `<div class="sk-body"><main id="sk-main"><div class="container"><div class="main-column"><div class="sk-frame">${card}</div></div>` +
    `<aside class="sidebar-column with-separate-line"><div class="sidebar-content">${c.asideHtml}</div></aside>` +
    `</div></main></div>${c.footerHtml}${pluginFooter}</div></body></html>`
  );
}
