// Locale core for the public site.
//
// Pure and import-free so it unit-tests without a database or the framework.
// The contract every caller relies on:
//
//   * The DEFAULT locale is served at bare paths ("/blog"), so every existing
//     URL, smoke assertion and bookmark keeps working untouched.
//   * A non-default locale lives under a path prefix ("/en/blog"). The
//     middleware canonicalizes ctx.pathname (prefix stripped) for loaders;
//     the resolve loader strips the same segment from its segments payload;
//     prefixLocaleUrls() re-prefixes root-relative hrefs in rendered chrome.
//   * Catalogs merge: the locale catalog overlays the default one, so a key
//     that has not been translated yet falls back to Chinese instead of
//     rendering a raw key. Partial coverage is a designed state, not a bug.

export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** Non-default locales, i.e. the ones that ride a path prefix. */
export const PREFIXED_LOCALES: Locale[] = LOCALES.filter(
  (l) => l !== DEFAULT_LOCALE,
) as Locale[];

// ------------------------------------------------------------------ catalogs

/** The default catalog. Chinese is the source of truth: every key exists here. */
export const zhCatalog: Record<string, string> = {
  "search.placeholder": "搜索文章…",
  "search.placeholder_short": "搜索…",
  "search.aria": "搜索文章",
  "search.submit": "搜索",
  "search.empty": "没有匹配「{q}」的文章",
  "search.all_hint": "共 {n} 篇，按 Enter 查看全部",
  "pager.prev": "上一页",
  "pager.next": "下一页",
  "pager.info": "第 {page}/{total} 页",
  "pager.aria": "分页",
  "crumb.home": "首页",
  "crumb.search": "搜索",
  "crumb.category": "分类",
  "crumb.tag": "标签",
  "crumb.page": "页面",
  "crumb.posts": "文章",
  "crumb.aria": "面包屑",
  "crumb.archive": "归档",
  "empty.category": "该分类下还没有文章。",
  "empty.search": "没有匹配的文章。",
  "empty.tag": "该标签下还没有文章。",
  "empty.posts": "还没有已发布的文章。",
  "post.reads": "{n} 阅读",
  "post.comments": "{n} 评论",
  "post.replies": "{n} 回应",
  "comments.title": "评论",
  "comments.replies": "回应",
  "empty.posts_admin": "还没有已发布的文章。去后台发布一篇，或先导入示例内容吧。",
  "pseudo.latest": "最新发布",
  "pseudo.explore": "探索文章",
  "pseudo.recent_updates": "最近更新",
  "pseudo.more": "查看更多文章",
  "pseudo.widgets": "侧栏",
  "pseudo.empty_home": "还没有文章。先去 admin 发布一篇吧。",
  "post.reads_tip": "已读",
  "post.likes_tip": "点赞",
  "post.gallery": "浏览相册",
  "post.back_list": "返回列表",
  "comments.closed": "评论已关闭。",
  "comments.closed_post": "本文已关闭评论。",
  "comments.nickname": "昵称",
  "comments.email": "邮箱",
  "comments.url_label": "链接",
  "comments.placeholder": "请输入...",
  "comments.emoji": "表情",
  "comments.cancel_reply": "取消回复",
  "comments.submit": "发表评论",
  "comments.submit_reply": "回复评论",
  "comments.empty": "还没有评论，来抢沙发吧。",
  "comments.reply": "回复",
  "comments.reply_to": "回复 {name}：",
  "comments.anonymous": "匿名",
  "comments.err_content": "请填写评论内容！",
  "comments.err_name": "昵称必填！",
  "comments.err_email": "邮箱必填！",
  "comments.err_url": "链接必填！",
  "comments.err_email_format": "请输入正确的邮箱格式！",
  "comments.ok_published": "评论已发布",
  "comments.ok_pending": "评论已提交，等待审核",
  "comments.err_fail": "提交失败",
  "comments.provider_unconfigured": "未配置第三方评论服务参数，请在「站点设置 → 评论」中填写。",
  "comments.placeholder_waline": "说点什么吧～",
  "rank.most_likes": "大家喜欢",
  "rank.random": "随机文章",
  "post.author_unknown": "未知作者",
  "post.share": "分享",
  "post.copy_link": "复制文章链接",
  "post.copy_label": "复制链接",
  "post.weibo": "微博",
  "post.email": "邮件",
  "post.x_aria": "分享到 X",
  "post.related": "相关文章",
  "post.toc": "目录",
  "post.read_more": "阅读全文",
  "post.featured": "推荐阅读",
  "post.read_time": "阅读时长",
  "post.read_minutes": "约 {n} 分钟",
  "sidebar.categories": "分类",
  "sidebar.tags": "标签",
  "sidebar.recent": "最新文章",
  "sidebar.no_categories": "暂无分类",
  "sidebar.no_tags": "暂无标签",
  "sidebar.no_posts": "暂无文章",
  "sidebar.home": "首页",
  "sidebar.all_posts": "所有文章",
  "nav.menu_open": "打开菜单",
  "cat.expand": "展开/收起 {name}",
  "cat.aria": "{name}分类页",
  "adjacent.older": "上一篇",
  "adjacent.newer": "下一篇",
  "adjacent.aria": "文章导航",
  "notfound.title": "页面不存在",
  "notfound.search_placeholder": "搜索文章…",
  "notfound.search_label": "搜索文章",
  "notfound.search_submit": "搜索",
  "notfound.back_home": "返回首页",
  "notfound.take_me_home": "带我回家",
  "notfound.recent": "最近文章",
  "locale.switch": "English",
  "locale.switch_en": "中文",
  "list.latest_bm": "最新文章 · {n} 篇",
  "list.all": "全部文章",
  "list.sub": "共 {n} 篇 · 第 {page}/{total} 页",
  "list.category_title": "分类：{name}",
  "search.title": "搜索",
  "search.title_q": "搜索：“{q}”",
  "search.title_bm": "搜索 “{q}” · {n} 篇",
  "search.sub_results": "共 {n} 条结果 · 第 {page}/{total} 页",
  "search.sub_found": "找到 {n} 篇结果",
  "search.sub_hint": "在顶部搜索框输入关键词",
  "search.all_lead": "没有想找的内容？",
  "search.all_link": "查看全部结果",
  "search.empty_hint": "输入关键词，从右上角搜索框或导航搜索寻找内容。",
  "archives.count": "共 {n} 篇文章",
  "archives.empty": "这个时间段还没有文章。",
  "archives.desc": "{site} 的全部文章按时间归档",
  "reading.progress": "阅读进度",
  "reading.title": "阅读模式",
  "reading.exit_hint": "阅读模式 (Esc 退出)",
  "reading.settings": "阅读模式设置",
  "reading.width": "栏宽",
  "reading.width_default": "默认",
  "reading.width_narrow": "窄栏",
  "reading.width_wide": "宽栏",
  "reading.font": "字体",
  "reading.font_sans": "无衬线",
  "reading.font_serif": "衬线",
  "reading.size_lh": "字号与行距",
  "reading.size_dec": "减小字号",
  "reading.size_inc": "增大字号",
  "reading.lh_dec": "减小行距",
  "reading.lh_inc": "增大行距",
  "reading.reset": "恢复默认",
  "reading.enter": "开启阅读模式",
  "reading.exit": "退出阅读模式",
  "pjax.copied": "已复制",
  "pjax.shared": "已分享",
  "pjax.copy_failed": "复制失败",
  "pjax.no_match": "没有匹配「{q}」的文章",
  "pjax.total": "共 {n} 篇，按 Enter 查看全部",
  "pjax.toc": "目录",
  "theme.poster": "生成海报",
  "theme.share_weibo": "分享到微博",
  "theme.share_qq": "分享到QQ",
  "theme.share_qzone": "分享到QQ空间",
  "theme.like": "点赞",
  "theme.liked": "已点赞",
  "theme.poster_soon": "海报功能将在后续版本上线",
  "theme.already_liked": "您已经点过赞了",
  "theme.liking": "正在处理点赞...",
  "theme.like_ok": "点赞成功！",
  "theme.reads": "{n} 阅读",
  "theme.comments": "{n} 条评论",
  "sky.sidebar_open": "打开侧栏",
  "sky.toolbox_open": "打开工具箱",
  "sky.color_mode": "色彩模式",
  "sky.welcome": "欢迎光临",
  "sky.about": "关于我",
  "sky.stats": "博客统计",
  "sky.stats_posts": "日志总数：{n} 篇",
  "sky.stats_comments": "评论数目：{n} 条",
  "sky.stats_tags": "标签总数：{n} 个",
  "sky.stats_cats": "分类总数：{n} 个",
  "sky.popular": "最受欢迎",
};

/** English overlays. Missing keys fall back to zhCatalog by design. */
export const enCatalog: Record<string, string> = {
  "search.placeholder": "Search posts…",
  "search.placeholder_short": "Search…",
  "search.aria": "Search posts",
  "search.submit": "Search",
  "search.empty": "No posts matching “{q}”",
  "search.all_hint": "{n} posts — press Enter for all",
  "pager.prev": "Previous",
  "pager.next": "Next",
  "pager.info": "Page {page} of {total}",
  "pager.aria": "Pagination",
  "crumb.home": "Home",
  "crumb.search": "Search",
  "crumb.category": "Categories",
  "crumb.tag": "Tags",
  "crumb.page": "Pages",
  "crumb.posts": "Posts",
  "crumb.aria": "Breadcrumb",
  "crumb.archive": "Archive",
  "empty.category": "No posts in this category yet.",
  "empty.search": "No matching posts.",
  "empty.tag": "No posts with this tag yet.",
  "empty.posts": "No published posts yet.",
  "post.reads": "{n} views",
  "post.comments": "{n} comments",
  "post.replies": "{n} replies",
  "comments.title": "Comments",
  "comments.replies": "Replies",
  "empty.posts_admin": "No published posts yet. Publish one from the admin, or import the sample content.",
  "pseudo.latest": "Latest",
  "pseudo.explore": "Explore",
  "pseudo.recent_updates": "Recent",
  "pseudo.more": "More posts",
  "pseudo.widgets": "Sidebar",
  "pseudo.empty_home": "No posts yet. Publish one from the admin.",
  "post.reads_tip": "Reads",
  "post.likes_tip": "Likes",
  "post.gallery": "Browse gallery",
  "post.back_list": "Back to list",
  "comments.closed": "Comments are closed.",
  "comments.closed_post": "Comments are closed for this post.",
  "comments.nickname": "Nickname",
  "comments.email": "Email",
  "comments.url_label": "Website",
  "comments.placeholder": "Write a comment...",
  "comments.emoji": "Emoji",
  "comments.cancel_reply": "Cancel reply",
  "comments.submit": "Post comment",
  "comments.submit_reply": "Reply",
  "comments.empty": "No comments yet. Be the first to comment.",
  "comments.reply": "Reply",
  "comments.reply_to": "Replying to {name}:",
  "comments.anonymous": "Anonymous",
  "comments.err_content": "Please write a comment.",
  "comments.err_name": "Nickname is required.",
  "comments.err_email": "Email is required.",
  "comments.err_url": "Link is required.",
  "comments.err_email_format": "Please enter a valid email address.",
  "comments.ok_published": "Comment published.",
  "comments.ok_pending": "Comment submitted, awaiting review.",
  "comments.err_fail": "Submission failed.",
  "comments.provider_unconfigured": "The third-party comment service is not configured. Fill it in under Site Settings > Comments.",
  "comments.placeholder_waline": "Say something~",
  "rank.most_likes": "Most liked",
  "rank.random": "Random posts",
  "post.author_unknown": "Unknown author",
  "post.share": "Share",
  "post.copy_link": "Copy post link",
  "post.copy_label": "Copy link",
  "post.weibo": "Weibo",
  "post.email": "Email",
  "post.x_aria": "Share on X",
  "post.related": "Related posts",
  "post.toc": "Contents",
  "post.read_more": "Read more",
  "post.featured": "Featured",
  "post.read_time": "Reading time",
  "post.read_minutes": "{n} min",
  "sidebar.categories": "Categories",
  "sidebar.tags": "Tags",
  "sidebar.recent": "Recent posts",
  "sidebar.no_categories": "No categories",
  "sidebar.no_tags": "No tags",
  "sidebar.no_posts": "No posts",
  "sidebar.home": "Home",
  "sidebar.all_posts": "All posts",
  "nav.menu_open": "Open menu",
  "cat.expand": "Expand/collapse {name}",
  "cat.aria": "{name} category page",
  "adjacent.older": "Previous",
  "adjacent.newer": "Next",
  "adjacent.aria": "Post navigation",
  "notfound.title": "Page not found",
  "notfound.search_placeholder": "Search posts…",
  "notfound.search_label": "Search posts",
  "notfound.search_submit": "Search",
  "notfound.back_home": "Back to home",
  "notfound.take_me_home": "Take me home",
  "notfound.recent": "Recent posts",
  "locale.switch": "中文",
  "locale.switch_en": "English",
  "list.latest_bm": "Latest · {n} posts",
  "list.all": "All posts",
  "list.sub": "{n} posts · page {page} of {total}",
  "list.category_title": "Category: {name}",
  "search.title": "Search",
  "search.title_q": "Search: “{q}”",
  "search.title_bm": "Search “{q}” · {n} posts",
  "search.sub_results": "{n} results · page {page} of {total}",
  "search.sub_found": "{n} posts found",
  "search.sub_hint": "Type a keyword in the search box above",
  "search.all_lead": "Not finding what you need?",
  "search.all_link": "See all results",
  "search.empty_hint": "Type a keyword in the header or nav search box to find content.",
  "archives.count": "{n} posts",
  "archives.empty": "No posts in this period yet.",
  "archives.desc": "All posts on {site}, archived by date",
  "reading.progress": "Reading progress",
  "reading.title": "Reading mode",
  "reading.exit_hint": "Reading mode (Esc to exit)",
  "reading.settings": "Reading mode settings",
  "reading.width": "Column width",
  "reading.width_default": "Default",
  "reading.width_narrow": "Narrow",
  "reading.width_wide": "Wide",
  "reading.font": "Font",
  "reading.font_sans": "Sans-serif",
  "reading.font_serif": "Serif",
  "reading.size_lh": "Size & line height",
  "reading.size_dec": "Decrease font size",
  "reading.size_inc": "Increase font size",
  "reading.lh_dec": "Decrease line height",
  "reading.lh_inc": "Increase line height",
  "reading.reset": "Reset to defaults",
  "reading.enter": "Enter reading mode",
  "reading.exit": "Exit reading mode",
  "pjax.copied": "Copied",
  "pjax.shared": "Shared",
  "pjax.copy_failed": "Copy failed",
  "pjax.no_match": "No posts matching \u201c{q}\u201d",
  "pjax.total": "{n} posts in total, press Enter to see all",
  "pjax.toc": "Contents",
  "theme.poster": "Generate poster",
  "theme.share_weibo": "Share to Weibo",
  "theme.share_qq": "Share to QQ",
  "theme.share_qzone": "Share to Qzone",
  "theme.like": "Like",
  "theme.liked": "Liked",
  "theme.poster_soon": "The poster feature is coming soon",
  "theme.already_liked": "You have already liked this",
  "theme.liking": "Liking...",
  "theme.like_ok": "Liked!",
  "theme.reads": "{n} reads",
  "theme.comments": "{n} comments",
  "sky.sidebar_open": "Open sidebar",
  "sky.toolbox_open": "Open toolbox",
  "sky.color_mode": "Color mode",
  "sky.welcome": "Welcome",
  "sky.about": "About me",
  "sky.stats": "Blog stats",
  "sky.stats_posts": "Posts: {n}",
  "sky.stats_comments": "Comments: {n}",
  "sky.stats_tags": "Tags: {n}",
  "sky.stats_cats": "Categories: {n}",
  "sky.popular": "Most popular",
};

/** The catalog for a locale: English overlaid on the Chinese defaults. */
export function catalogFor(locale: Locale): Record<string, string> {
  return locale === DEFAULT_LOCALE ? zhCatalog : { ...zhCatalog, ...enCatalog };
}

// ------------------------------------------------------------------ matching

/**
 * Normalize a BCP-47-ish tag to one of the supported locales, or null.
 * Region/subtags are folded ("en-US", "en_gb" → en; "zh-Hans-CN" → zh-CN) so
 * a browser's full tag still lands on a catalog.
 */
export function normalizeLocale(tag: unknown): Locale | null {
  if (typeof tag !== "string") return null;
  const t = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!t) return null;
  const primary = t.split("-")[0];
  if (primary === "zh") return "zh-CN";
  if (primary === "en") return "en";
  return null;
}

/**
 * Accept-Language candidates, best first. q-values decide the order, ties keep
 * header order, unsupported tags are dropped, and a bare "*" (if nothing
 * concrete matched) contributes the default locale last.
 */
export function parseAcceptLanguage(header: unknown): Locale[] {
  if (typeof header !== "string" || !header.trim()) return [];
  const scored: { tag: string; q: number; i: number }[] = [];
  let wildcard = false;
  header.split(",").forEach((part, i) => {
    const bits = part.trim().split(";");
    const tag = (bits[0] || "").trim();
    if (!tag) return;
    let q = 1;
    for (const param of bits.slice(1)) {
      const m = /^q\s*=\s*([0-9.]+)$/i.exec(param.trim());
      if (m) q = Math.min(1, Math.max(0, Number(m[1]) || 0));
    }
    if (tag === "*") {
      wildcard = true;
      return;
    }
    scored.push({ tag, q, i });
  });
  scored.sort((a, b) => b.q - a.q || a.i - b.i);
  const out: Locale[] = [];
  for (const s of scored) {
    const loc = normalizeLocale(s.tag);
    if (loc && !out.includes(loc)) out.push(loc);
  }
  if (wildcard && !out.includes(DEFAULT_LOCALE)) out.push(DEFAULT_LOCALE);
  return out;
}

/**
 * Resolve the locale for a request. URL prefix wins (it is the only signal
 * the client can reproduce, which keeps hydration deterministic); the
 * Accept-Language list is consulted next; the default closes the list.
 */
export function pickLocale(input: {
  url?: unknown;
  accept?: unknown;
}): Locale {
  const fromUrl = normalizeLocale(input.url);
  if (fromUrl) return fromUrl;
  for (const cand of parseAcceptLanguage(input.accept)) return cand;
  return DEFAULT_LOCALE;
}

// --------------------------------------------------------------------- paths

export interface LocalePath {
  locale: Locale;
  /** The canonical path: prefix stripped for a prefixed locale. */
  path: string;
  /** True when the request carried a locale prefix. */
  prefixed: boolean;
}

/**
 * Split a locale prefix off a path. Only a whole first segment counts, so
 * "/en" and "/en/blog" are prefixed while "/enx" and "/enigma" are not.
 * An unknown first segment is left alone (it may be a real page slug).
 */
export function splitLocalePath(rawPath: unknown): LocalePath {
  let p = typeof rawPath === "string" ? rawPath : "/";
  if (!p.startsWith("/")) p = "/" + p;
  const m = /^\/([^/?#]+)([^?#]*)/.exec(p);
  if (m) {
    const loc = normalizeLocale(m[1]);
    if (loc && loc !== DEFAULT_LOCALE) {
      const rest = m[2] || "/";
      return { locale: loc, path: rest, prefixed: true };
    }
  }
  return { locale: DEFAULT_LOCALE, path: p, prefixed: false };
}

/**
 * The same path under another locale. The default locale is prefix-free, so
 * switching to it strips the prefix; switching to English adds it. Already
 * prefixed input is never double-prefixed.
 */
export function localeHref(rawPath: string, locale: Locale): string {
  let p = typeof rawPath === "string" && rawPath ? rawPath : "/";
  if (!p.startsWith("/")) p = "/" + p;
  if (locale === DEFAULT_LOCALE) {
    return p.replace(/^\/en(?=\/|$)/, "") || "/";
  }
  if (/^\/en(?=\/|$)/.test(p)) return p;
  return p === "/" ? "/en/" : "/en" + p;
}

/** The other locale — what the switcher links to. */
export function otherLocale(locale: Locale): Locale {
  return locale === DEFAULT_LOCALE ? "en" : DEFAULT_LOCALE;
}

/** <html lang> value. "en" needs no region; Chinese keeps its subtag. */
export function htmlLangOf(locale: Locale): string {
  return locale === "en" ? "en" : "zh-CN";
}

// ------------------------------------------------------------------ rendering

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** A bound translator for one locale. Unknown keys render as the key. */
export function makeT(locale: Locale): Translate {
  const cat = catalogFor(locale);
  return (key, vars) => {
    let s = cat[key];
    if (s == null) s = key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        s = s.split(`{${k}}`).join(String(vars[k]));
      }
    }
    return s;
  };
}

/** One-shot translate (tests and one-off call sites). */
export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  return makeT(locale)(key, vars);
}

// ------------------------------------------------------------------- URLs

/** First path segments that must never take a locale prefix. */
const NO_PREFIX_SEGMENTS = new Set([
  "api",
  "public",
  "uploads",
  "theme-assets",
  "plugin-assets",
  "theme-style",
  "admin",
  "en",
  "feed",
  "feed.xml",
  "rss.xml",
  "sitemap.xml",
  "robots.txt",
  "manifest.webmanifest",
  "favicon.ico",
]);

/**
 * Prefix every root-relative href/action in a rendered HTML fragment so
 * navigation stays inside the locale. Assets, APIs, feeds and the admin keep
 * their canonical paths; protocol-relative and non-root URLs are untouched.
 * The default locale is a no-op, which is what keeps the zh-CN output
 * byte-identical to before this feature existed.
 */
export function prefixLocaleUrls(html: string, locale: Locale): string {
  if (!html || locale === DEFAULT_LOCALE) return html;
  return html.replace(/(href|action)="(\/[^"]*)"/g, (full, attr: string, urlPath: string) => {
    if (urlPath.startsWith("//")) return full;
    const seg = urlPath.slice(1).split(/[/?#]/)[0];
    if (NO_PREFIX_SEGMENTS.has(seg)) return full;
    if (urlPath === "/") return `${attr}="/en/"`;
    return `${attr}="/en${urlPath}"`;
  });
}

/**
 * hreflang alternates for the document head: both locales plus x-default.
 * Canonical stays the bare (default-locale) path, so this is additive SEO
 * metadata rather than a competing canonical.
 */
export function hreflangLinks(origin: string, path: string): string {
  const base = `${origin || ""}${path}`;
  const en = `${origin || ""}${localeHref(path, "en")}`;
  // Head blocks dedupe by name|property|rel|charset (first wins), so three
  // bare rel="alternate" links would collapse into one and could evict the
  // RSS alternate from the same head. A distinct name per link keeps them.
  return (
    `<link name="hreflang-zh-CN" rel="alternate" hreflang="zh-CN" href="${base}">` +
    `<link name="hreflang-en" rel="alternate" hreflang="en" href="${en}">` +
    `<link name="hreflang-x-default" rel="alternate" hreflang="x-default" href="${base}">`
  );
}
