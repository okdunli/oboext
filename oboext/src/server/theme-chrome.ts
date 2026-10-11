/**
 * Theme-aware chrome rendering.
 *
 * Each theme provides its own nav/wrapper/footer HTML structure and content
 * builders. The active theme's chrome is assembled by `buildChrome()` and
 * consumed by `_layout.rose` via the `chrome` loader.
 *
 * Skyscraper keeps its existing renderers in render.ts; the other four themes
 * have their builders here.
 */
import fs from "fs";
import path from "path";
import type { PostView, TaxRef } from "./queries.js";
import type { PageView } from "./pages.js";
import * as R from "./render.js";
import { esc, fmtDate } from "./render.js";

export interface ThemeChrome {
  slug: string;
  cssHref(): string;
  bodyFix(): string;
  headExtra(): string;
  nav(settings: Record<string, any>, menuItems: MenuItem[]): string;
  bodyOpen(settings: Record<string, any>, menuItems: MenuItem[]): string;
  bodyClose(settings: Record<string, any>, footerHtml: string): string;
  aside(parts: AsideParts): string;
  footer(settings: Record<string, any>, widgetsHtml: string): string;
  home(parts: HomeParts): string;
  listPage(parts: ListParts): string;
  postPage(parts: PostPageParts): string;
  pagePage(parts: PagePageParts): string;
}

export type MenuItem = {
  id: number | string;
  label: string;
  url: string;
  target?: string;
  children?: MenuItem[];
};

export type AsideParts = {
  menu: string;
  tagCloud: string;
  stats: string;
  popular: string;
  widgets: string;
};

export type HomeParts = {
  hero: PostView[];
  latest: PostView[];
  liked: PostView[];
  random: PostView[];
  cats: TaxRef[];
  settings: Record<string, unknown>;
};

export type ListParts = {
  title: string;
  sub: string;
  items: PostView[];
  page: number;
  totalPages: number;
  hrefFor: (p: number) => string;
  showPager?: boolean;
  extra?: string;
};

export type PostPageParts = {
  post: PostView;
  bodyHtml: string;
  related: PostView[];
  commentsHtml: string;
  metaHtml: string;
  tagsHtml: string;
  shareHtml: string;
};

export type PagePageParts = {
  page: PageView;
  bodyHtml: string;
  recent: PostView[];
  commentsHtml: string;
};

const THEMES_DIR = path.join(process.cwd(), "themes");

let cssCache = new Map<string, { css: string; mtime: number }>();

function readThemeCss(slug: string, file: string): { css: string; mtime: number } {
  const key = slug + ":" + file;
  const cached = cssCache.get(key);
  if (cached) return cached;
  try {
    const fp = path.join(THEMES_DIR, slug, file);
    const st = fs.statSync(fp);
    const css = fs.readFileSync(fp, "utf-8");
    const entry = { css, mtime: st.mtimeMs };
    cssCache.set(key, entry);
    return entry;
  } catch {
    return { css: "", mtime: 0 };
  }
}

function themeCssHref(slug: string): string {
  if (slug === "skyscraper") return "/public/theme.css";
  const main = readThemeCss(slug, slug + ".css");
  let v = String(Math.round(main.mtime));
  try {
    const extra = readThemeCss(slug, slug + "-extra.css");
    if (extra.mtime) v += "-" + String(Math.round(extra.mtime));
  } catch { /* no extra */ }
  return `/theme-style/${slug}?v=${v}`;
}

export function themeCssContent(slug: string): string {
  if (slug === "skyscraper") return "";
  const main = readThemeCss(slug, slug + ".css");
  let css = main.css;
  try {
    const extra = readThemeCss(slug, slug + "-extra.css");
    if (extra.css) css += "\n" + extra.css;
  } catch { /* no extra */ }
  return css;
}

function menuItemsHtml(items: MenuItem[], cls: string, activeUrl: string): string {
  return items
    .map(
      (it) =>
        `<a href="${esc(it.url)}"${it.target && it.target !== "_self" ? ` target="${esc(it.target)}" rel="noopener"` : ""}>${esc(it.label)}</a>`,
    )
    .join("");
}

function pagerHtml(page: number, totalPages: number, hrefFor: (p: number) => string): string {
  if (totalPages <= 1) return "";
  const prev = page > 1 ? `<a href="${esc(hrefFor(page - 1))}" class="pager-prev">&laquo; 上一页</a>` : "";
  const next = page < totalPages ? `<a href="${esc(hrefFor(page + 1))}" class="pager-next">下一页 &raquo;</a>` : "";
  return `<nav class="ob-pager">${prev}<span class="pager-info">第 ${page}/${totalPages} 页</span>${next}</nav>`;
}

const skyscraperChrome: ThemeChrome = {
  slug: "skyscraper",
  cssHref: () => "/public/theme.css",
  bodyFix: () => "",
  headExtra: () => "",
  nav: (settings) => R.topNav(settings),
  bodyOpen: () =>
    `<div class="sk-body"><main id="sk-main"><div class="container"><div class="main-column"><div class="sk-frame">`,
  bodyClose: () => `</div></div>`,
  aside: (parts) =>
    `<aside class="sidebar-column with-separate-line"><div class="sidebar-content">` +
    parts.menu + parts.tagCloud + parts.stats + parts.popular + parts.widgets +
    `</div></aside>`,
  footer: (settings, widgetsHtml) => R.footerHtml(settings, widgetsHtml),
  home: (parts) =>
    R.homeHtml({
      hero: parts.hero,
      latest: parts.latest,
      liked: parts.liked,
      random: parts.random,
      cats: parts.cats,
    }),
  listPage: (parts) =>
    R.listPage({
      title: parts.title,
      sub: parts.sub,
      items: parts.items,
      page: parts.page,
      totalPages: parts.totalPages,
      hrefFor: parts.hrefFor,
      showPager: parts.showPager,
      extra: parts.extra,
    }),
  postPage: (parts) =>
    R.postPage(parts.post, parts.related, parts.commentsHtml, []),
  pagePage: (parts) =>
    R.pagePage(parts.page, parts.recent, parts.commentsHtml),
};

const defaultBodyFix = `body,html{background:var(--bg,#09090b)!important;color:var(--text,#f4f4f5)!important;}`;

function defaultMenuUl(items: MenuItem[], cls: string): string {
  if (!items.length) return "";
  const lis = items
    .map((it) => `<li><a href="${esc(it.url)}"${it.target && it.target !== "_self" ? ` target="${esc(it.target)}" rel="noopener"` : ""} class="px-2 py-1 text-sm text-[var(--muted)] transition hover:text-[var(--accent)]">${esc(it.label)}</a></li>`)
    .join("");
  return `<ul class="${cls}">${lis}</ul>`;
}

function defaultNav(settings: Record<string, any>, items: MenuItem[]): string {
  const title = esc(settings.siteTitle ?? "");
  const headingClass = "text-zinc-100";
  const brandLink =
    settings.logoUrl
      ? `<img src="${esc(settings.logoUrl)}" alt="${title}" class="h-7 w-auto">`
      : `<span class="flex h-8 w-8 items-center justify-center rounded-lg font-bold" style="background:var(--accent);color:var(--accent-text)">${(title || "").charAt(0).toUpperCase()}</span>${title}`;
  const menu = defaultMenuUl(items, "flex flex-wrap items-center");
  return `<div class="theme-root relative flex min-h-screen flex-col">` +
    `<header class="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--header-bg)] backdrop-blur">` +
    `<div class="relative mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">` +
    `<a href="/" class="flex items-center gap-2 text-lg font-bold tracking-tight ${headingClass}">${brandLink}</a>` +
    `<nav class="ml-2 hidden flex-1 md:block">${menu}</nav>` +
    `<form action="/search" method="get" class="ml-auto hidden sm:block"><div class="relative">` +
    `<span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]">⌕</span>` +
    `<input name="q" placeholder="搜索…" class="w-44 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-9 pr-3 text-sm outline-none focus:border-[var(--accent)]">` +
    `</div></form></div></header>`;
}

function defaultFooter(settings: Record<string, any>, widgetsHtml: string): string {
  const year = new Date().getFullYear();
  const copy = esc(settings.footerText || `© ${year} ${settings.siteTitle}`);
  const menu = defaultMenuUl((settings.footerMenu as MenuItem[]) || [], "flex flex-wrap items-center gap-1 text-sm text-zinc-400");
  return `<footer class="relative border-t border-[var(--border)] bg-[var(--footer-bg)] px-4 py-8">` +
    `<div class="mx-auto max-w-5xl">` +
    (widgetsHtml ? `<div class="mb-6">${widgetsHtml}</div>` : "") +
    (menu ? `<nav class="mb-4">${menu}</nav>` : "") +
    `<p class="text-xs text-zinc-500">${copy}</p>` +
    `</div></footer>`;
}

function defaultCatPill(c: { name: string; url?: string }): string {
  const label = esc(c.name);
  const cls = "rounded-full bg-[var(--accent)]/15 px-2.5 py-0.5 text-xs text-[var(--accent)]";
  return c.url ? `<a href="${esc(c.url)}" class="${cls}">${label}</a>` : `<span class="${cls}">${label}</span>`;
}

function defaultPostCard(p: PostView, idx: number): string {
  const cats = ((p.categories || []).slice(0, 2).map(defaultCatPill)).join("");
  const author = esc(p.author?.name ?? "未知作者");
  return `<article class="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]">` +
    (p.featuredImage
      ? `<a href="${esc(p.url)}" class="block aspect-[16/9] overflow-hidden"><img src="${esc(p.featuredImage)}" alt="${esc(p.title)}" class="h-full w-full object-cover transition duration-300 group-hover:scale-105" loading="lazy"></a>`
      : "") +
    `<div class="flex flex-1 flex-col p-5">` +
    (cats ? `<div class="mb-2 flex flex-wrap gap-2 text-xs">${cats}</div>` : "") +
    `<h2 class="text-lg font-semibold leading-snug text-[var(--text)]"><a href="${esc(p.url)}" class="transition group-hover:text-[var(--accent)]">${esc(p.title)}</a></h2>` +
    (p.excerpt ? `<p class="mt-2 line-clamp-3 flex-1 text-sm text-[var(--muted)]">${esc(p.excerpt)}</p>` : "") +
    `<div class="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">` +
    `<span class="inline-flex items-center gap-1">${author}</span>` +
    `<span class="inline-flex items-center gap-1">${fmtDate(p.publishedAt)}</span>` +
    (p.commentsCount > 0 ? `<span class="inline-flex items-center gap-1">${p.commentsCount} 评论</span>` : "") +
    `</div></div></article>`;
}

function defaultHome(parts: HomeParts): string {
  const siteTitle = esc((parts.settings.siteTitle as string) ?? "");
  const tagline = parts.settings.tagline ? `<p class="mt-3 text-base text-zinc-400">${esc(parts.settings.tagline as string)}</p>` : "";
  const desc = parts.settings.siteDescription
    ? `<p class="mx-auto mt-3 max-w-2xl text-sm text-zinc-500">${esc(parts.settings.siteDescription as string)}</p>`
    : "";
  const hero = `<section class="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-gradient-to-br from-[var(--surface)] to-[var(--bg)] px-8 py-12 text-center">` +
    `<span class="mx-auto mb-4 block text-center text-[var(--accent)]" style="font-size:28px;line-height:1">✦</span>` +
    `<h1 class="text-4xl font-bold tracking-tight text-zinc-100">${siteTitle}</h1>${tagline}${desc}</section>`;
  const all = [...parts.hero, ...parts.latest];
  const featured = all[0];
  const rest = all.slice(1);
  let featuredHtml = `<p class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-zinc-400">还没有已发布的文章。</p>`;
  if (featured) {
    const cats = ((featured.categories || []).slice(0, 3).map(defaultCatPill)).join("");
    featuredHtml = `<article class="group overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)]">` +
      (featured.featuredImage
        ? `<a href="${esc(featured.url)}" class="block aspect-[21/9] overflow-hidden"><img src="${esc(featured.featuredImage)}" alt="${esc(featured.title)}" class="h-full w-full object-cover transition duration-300 group-hover:scale-105" loading="lazy"></a>`
        : "") +
      `<div class="p-6">${cats ? `<div class="mb-2 flex flex-wrap gap-2 text-xs">${cats}</div>` : ""}` +
      `<h2 class="text-2xl font-bold leading-snug text-zinc-100"><a href="${esc(featured.url)}" class="transition group-hover:text-[var(--accent)]">${esc(featured.title)}</a></h2>` +
      `<span class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)]">✦ 推荐阅读</span>` +
      (featured.excerpt ? `<p class="mt-3 line-clamp-3 text-sm text-zinc-400">${esc(featured.excerpt)}</p>` : "") +
      `</div></article>`;
  }
  const grid = rest.map((p, i) => defaultPostCard(p, i)).join("");
  return `<div class="space-y-10">${hero}` +
    `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><div class="space-y-6">${featuredHtml}` +
    (rest.length ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">${grid}</div>` : "") +
    `</div>${defaultAside(parts)}</div></div>`;
}

function defaultAside(parts: HomeParts): string {
  const cats = parts.cats || [];
  const recent = [...parts.hero, ...parts.latest].slice(0, 5);
  const catLis = cats.map((c) =>
    `<li><a href="${esc(c.url)}" class="flex items-center gap-1.5 text-sm text-[var(--text)] hover:text-[var(--accent)]">${esc(c.name)}</a></li>`).join("");
  const recentLis = recent.map((p) =>
    `<li><a href="${esc(p.url)}" class="text-sm text-[var(--text)] hover:text-[var(--accent)]">${esc(p.title)}</a><p class="text-xs text-[var(--muted)]">${fmtDate(p.publishedAt)}</p></li>`).join("");
  return `<aside class="space-y-6">` +
    `<form action="/search" method="get"><div class="relative">` +
    `<span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]">⌕</span>` +
    `<input name="q" placeholder="搜索文章…" class="w-full rounded-full border border-[var(--border)] bg-[var(--surface)] py-2 pl-9 pr-4 text-sm outline-none focus:border-[var(--accent)]">` +
    `</div></form>` +
    `<div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">分类</h3>` +
    `<ul class="space-y-1 text-sm">${catLis || `<li class="text-sm text-[var(--muted)]">暂无分类</li>`}</ul></div>` +
    `<div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">最新文章</h3>` +
    `<ul class="space-y-2 text-sm">${recentLis || `<li class="text-sm text-[var(--muted)]">暂无文章</li>`}</ul></div>` +
    `</aside>`;
}

function defaultListPage(parts: ListParts): string {
  const cards = parts.items.map((p, i) => defaultPostCard(p, i)).join("");
  const pager = parts.showPager !== false ? pagerHtml(parts.page, parts.totalPages, parts.hrefFor) : "";
  return `<div class="space-y-6"><header class="mb-6">` +
    `<h1 class="text-3xl font-bold tracking-tight text-zinc-100">${esc(parts.title)}</h1>` +
    `<p class="mt-2 text-sm text-zinc-500">${esc(parts.sub)}</p></header>` +
    (parts.extra || "") +
    `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">${cards}</div>${pager}</div>`;
}

function defaultPostPage(parts: PostPageParts): string {
  const p = parts.post;
  const cats = (p.categories || []).map(defaultCatPill).join("");
  const author = esc(p.author?.name ?? "未知作者");
  const meta = parts.metaHtml || "";
  const tags = parts.tagsHtml || "";
  const crumb = `<nav class="mb-6 flex items-center gap-2 text-xs text-zinc-500">` +
    `<a href="/" class="hover:text-[var(--accent)]">首页</a><span>›</span><a href="/blog" class="hover:text-[var(--accent)]">文章</a>` +
    ((p.categories || [])[0] ? `<span>›</span><a href="${esc((p.categories as any)[0].url || "#")}" class="hover:text-[var(--accent)]">${esc((p.categories as any)[0].name)}</a>` : "") +
    `<span>›</span><span class="text-zinc-300">${esc(p.title)}</span></nav>`;
  return `<article class="mx-auto max-w-3xl">` +
    `<header class="mb-6">` +
    `<a href="/" class="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-[var(--accent)]">← 返回首页</a>` +
    crumb +
    (cats ? `<div class="mb-3 mt-3 flex flex-wrap gap-2 text-xs">${cats}</div>` : "") +
    `<h1 class="text-3xl font-bold leading-tight text-zinc-100">${esc(p.title)}</h1>` +
    `<div class="mt-3 flex flex-wrap items-center gap-4 text-sm text-zinc-500">` +
    `<span class="inline-flex items-center gap-1">${author}</span>` +
    `<span class="inline-flex items-center gap-1">${fmtDate(p.publishedAt)}</span>` +
    `<span class="inline-flex items-center gap-1">${p.views} 阅读</span>` +
    (p.commentsCount > 0 ? `<span class="inline-flex items-center gap-1">${p.commentsCount} 评论</span>` : "") +
    `</div>${meta ? `<div class="mt-2 flex flex-wrap items-center gap-4 text-sm text-zinc-500">${meta}</div>` : ""}` +
    `</header>` +
    (p.featuredImage ? `<img src="${esc(p.featuredImage)}" alt="${esc(p.title)}" class="mb-6 w-full rounded-2xl border border-[var(--border)] object-cover">` : "") +
    `<div class="prose-cms">${parts.bodyHtml}</div>` +
    (tags ? `<div class="mt-8 border-t border-[var(--border)] pt-6">${tags}</div>` : "") +
    `<div class="mt-8">${parts.shareHtml}</div>` +
    `<div class="mt-8">${parts.commentsHtml}</div>` +
    `</article>`;
}

function defaultPagePage(parts: PagePageParts): string {
  const p = parts.page;
  return `<article class="mx-auto max-w-3xl">` +
    `<h1 class="mb-6 text-3xl font-bold leading-tight text-zinc-100">${esc(p.title)}</h1>` +
    `<div class="prose-cms">${parts.bodyHtml}</div>` +
    `<div class="mt-8">${parts.commentsHtml}</div>` +
    `</article>`;
}

const defaultChrome: ThemeChrome = {
  slug: "default",
  cssHref: () => themeCssHref("default"),
  bodyFix: () => defaultBodyFix,
  headExtra: () => "",
  nav: (settings, items) => defaultNav(settings, items),
  bodyOpen: (settings, items) => `${defaultNav(settings, items)}<main id="sk-main" class="relative mx-auto w-full max-w-5xl flex-1 px-4 py-8">`,
  bodyClose: (settings, footerHtml) => `</main>${footerHtml}</div>`,
  aside: () => "",
  footer: (settings, widgetsHtml) => defaultFooter(settings, widgetsHtml),
  home: defaultHome,
  listPage: defaultListPage,
  postPage: defaultPostPage,
  pagePage: defaultPagePage,
};

const pseudoBodyFix = `body,html{background:#0c0d1a!important;color:#f3f1ff!important;}`;

function pseudoNav(settings: Record<string, any>, items: MenuItem[]): string {
  const title = esc(settings.siteTitle ?? "");
  const links = items
    .map((it) => `<li><a href="${esc(it.url)}"${it.target ? ` target="${esc(it.target)}"` : ""}>${esc(it.label)}</a></li>`)
    .join("");
  return `<nav class="pl-nav"><div class="pl-nav-inner">` +
    `<a href="/" class="pl-brand"><span class="pl-brand-mark" aria-hidden="true"></span><span>${title}</span></a>` +
    `<ul class="pl-menu">${links}</ul>` +
    `<form action="/search" method="get" class="pl-search"><span class="pl-prompt">⌕</span><input name="q" placeholder="搜索文章、标签…" aria-label="search"></form>` +
    `<div class="pl-nav-status" aria-hidden="true"><span class="pl-dot"></span><span>live</span></div>` +
    `</div></nav>`;
}

function pseudoFooter(settings: Record<string, any>): string {
  const year = new Date().getFullYear();
  const copyright = esc(settings.footerText || `© ${year} ${settings.siteTitle}`);
  const tagline = esc((settings.tagline || settings.siteDescription || "A quiet log of things noticed, built and written down.") as string);
  return `<footer class="pl-footer"><div class="pl-footer-mark" aria-hidden="true"></div>` +
    `<h3>${esc(settings.siteTitle ?? "")}</h3><p>${tagline}</p>` +
    `<div class="pl-footer-bottom"><span>${copyright}</span><span>·</span>` +
    `<span>made with <span class="pl-heart">♥</span> &amp; signal noise</span>` +
    (settings.icpNumber ? `<span>·</span><a href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer">${esc(settings.icpNumber as string)}</a>` : "") +
    `</div></footer>`;
}

function pseudoPostCard(p: PostView, idx: number): string {
  const thumb = p.featuredImage
    ? `<div class="pl-thumb" style="background-image:url(${esc(p.featuredImage)})"></div>`
    : "";
  const cat = (p.categories || [])[0];
  const catHtml = cat ? `<span class="pl-cat">${esc(cat.name)}</span>` : "";
  return `<article class="pl-card">${thumb}` +
    `<div class="pl-card-meta"><span class="pl-num">${String(idx + 1).padStart(2, "0")}</span>${catHtml}</div>` +
    `<h3><a href="${esc(p.url)}">${esc(p.title)}</a></h3>` +
    (p.excerpt ? `<p>${esc(p.excerpt)}</p>` : "") +
    `<a href="${esc(p.url)}" class="pl-read">阅读全文 →</a>` +
    `</article>`;
}

function pseudoHome(parts: HomeParts): string {
  const all = [...parts.hero, ...parts.latest];
  const featured = all[0];
  const rest = all.slice(1);
  let heroHtml = "";
  if (featured) {
    heroHtml = `<section class="pl-hero"><div class="pl-hero-card">` +
      `<div class="pl-hero-eyebrow"><span class="pl-pill-dot"></span>Issue №01</div>` +
      `<h1 class="pl-title">${esc(featured.title)}</h1>` +
      (featured.excerpt ? `<p style="color:var(--pl-ink-2,#a8a3c4);font-size:16px;max-width:600px">${esc(featured.excerpt)}</p>` : "") +
      `<a href="${esc(featured.url)}" class="pl-read" style="margin-top:24px">阅读此文 →</a>` +
      `</div></section>`;
  }
  const cards = rest.map((p, i) => pseudoPostCard(p, i)).join("");
  return `${heroHtml}<div style="max-width:1280px;margin:0 auto;padding:0 22px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:24px">${cards}</div>`;
}

function pseudoListPage(parts: ListParts): string {
  const cards = parts.items.map((p, i) => pseudoPostCard(p, i)).join("");
  const pager = parts.showPager !== false ? pagerHtml(parts.page, parts.totalPages, parts.hrefFor) : "";
  return `<div style="max-width:1280px;margin:0 auto;padding:24px 22px">` +
    `<h1 style="font-family:var(--pl-display);font-weight:800;font-size:36px;margin:0 0 8px">${esc(parts.title)}</h1>` +
    `<p style="color:var(--pl-ink-3,#a8a3c4);margin:0 0 32px;font-size:14px">${esc(parts.sub)}</p>` +
    (parts.extra || "") +
    `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:24px">${cards}</div>${pager}</div>`;
}

function pseudoPostPage(parts: PostPageParts): string {
  const p = parts.post;
  const cats = (p.categories || []).map((c) => `<a href="${esc(c.url)}" style="color:var(--pl-pink,#f0abfc);text-decoration:none;font-size:12px">${esc(c.name)}</a>`).join(" · ");
  return `<article style="max-width:760px;margin:0 auto;padding:24px 22px">` +
    `<header style="margin-bottom:32px">${cats ? `<div style="margin-bottom:12px">${cats}</div>` : ""}` +
    `<h1 style="font-family:var(--pl-display);font-size:36px;font-weight:800;line-height:1.2;margin:0">${esc(p.title)}</h1>` +
    `<div style="margin-top:16px;display:flex;gap:16px;font-size:13px;color:var(--pl-ink-3)">` +
    `<span>${esc(p.author?.name ?? "未知作者")}</span><time>${fmtDate(p.publishedAt)}</time><span>${p.views} 阅读</span>` +
    `</div>${parts.metaHtml}</header>` +
    (p.featuredImage ? `<img src="${esc(p.featuredImage)}" alt="${esc(p.title)}" style="width:100%;border-radius:var(--pl-radius,24px);margin-bottom:32px">` : "") +
    `<div class="prose-cms">${parts.bodyHtml}</div>` +
    parts.tagsHtml + parts.shareHtml + parts.commentsHtml +
    `</article>`;
}

function pseudoPagePage(parts: PagePageParts): string {
  const p = parts.page;
  return `<article style="max-width:760px;margin:0 auto;padding:24px 22px">` +
    `<h1 style="font-family:var(--pl-display);font-size:36px;font-weight:800;margin:0 0 24px">${esc(p.title)}</h1>` +
    `<div class="prose-cms">${parts.bodyHtml}</div>${parts.commentsHtml}</article>`;
}

const pseudolinearChrome: ThemeChrome = {
  slug: "pseudolinear",
  cssHref: () => themeCssHref("pseudolinear"),
  bodyFix: () => pseudoBodyFix,
  headExtra: () => "",
  nav: (settings, items) => pseudoNav(settings, items),
  bodyOpen: (settings, items) =>
    `<div class="th-pseudo">` + pseudoNav(settings, items) + `<main id="sk-main">`,
  bodyClose: (settings, footerHtml) =>
    `</main>${footerHtml}</div>`,
  aside: () => "",
  footer: (settings) => pseudoFooter(settings),
  home: pseudoHome,
  listPage: pseudoListPage,
  postPage: pseudoPostPage,
  pagePage: pseudoPagePage,
};

const cmBodyFix = `body,html{background:#050a06!important;color:#9bff7a!important;}`;

function cmNav(settings: Record<string, any>, items: MenuItem[]): string {
  const title = esc(settings.siteTitle ?? "");
  const links = items
    .map((it) => `<li><a href="${esc(it.url)}"${it.target ? ` target="${esc(it.target)}"` : ""}>${esc(it.label)}</a></li>`)
    .join("");
  return `<nav class="cm-nav"><div class="cm-nav-inner">` +
    `<a href="/" class="cm-brand"><span>${title}</span><b>:~$</b></a>` +
    `<ul class="cm-menu">${links}</ul>` +
    `<form action="/search" method="get" class="cm-search"><input name="q" placeholder="search articles, tags..." aria-label="search"></form>` +
    `<div class="cm-nav-status" aria-hidden="true"><span class="cm-time"></span></div>` +
    `</div></nav>`;
}

function cmFooter(settings: Record<string, any>): string {
  const year = new Date().getFullYear();
  const copyright = esc(settings.footerText || `(c) ${year} ${settings.siteTitle}`);
  return `<footer class="cm-footer"><div class="cm-footer-inner"><div class="cm-footer-bottom">` +
    `<span>${copyright}</span><span>·</span>` +
    `<span>built with <span style="color:var(--cm-accent)">&lt;3</span> &amp; signal noise</span>` +
    (settings.icpNumber ? `<span>·</span><a href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer">${esc(settings.icpNumber as string)}</a>` : "") +
    `<span style="margin-left:auto"><span class="cm-prompt-tail">exit 0</span><span class="cm-cursor" aria-hidden="true"></span></span>` +
    `</div></div></footer>`;
}

function cmPostCard(p: PostView, idx: number): string {
  const cat = (p.categories || [])[0];
  const catHtml = cat ? `<span class="cm-cat">${esc(cat.name)}</span>` : "";
  return `<article class="cm-card">` +
    `<div class="cm-card-meta"><span class="cm-num">${String(idx + 1).padStart(2, "0")}</span>${catHtml}<span>${fmtDate(p.publishedAt)}</span></div>` +
    `<h3><a href="${esc(p.url)}">${esc(p.title)}</a></h3>` +
    (p.excerpt ? `<p>${esc(p.excerpt)}</p>` : "") +
    `</article>`;
}

function cmHome(parts: HomeParts): string {
  const all = [...parts.hero, ...parts.latest];
  const cards = all.map((p, i) => cmPostCard(p, i)).join("");
  return `<div class="cm-hero"><h1 style="font-size:20px;color:var(--cm-accent)">> ls -la /blog</h1>` +
    `<p style="color:var(--cm-ink-3);font-size:13px">总共有 ${all.length} 篇文章</p></div>` +
    `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px">${cards}</div>`;
}

function cmListPage(parts: ListParts): string {
  const cards = parts.items.map((p, i) => cmPostCard(p, i)).join("");
  const pager = parts.showPager !== false ? pagerHtml(parts.page, parts.totalPages, parts.hrefFor) : "";
  return `<div><div class="cm-hero"><h1 style="font-size:18px;color:var(--cm-accent)">> ${esc(parts.title)}</h1>` +
    `<p style="color:var(--cm-ink-3);font-size:13px">${esc(parts.sub)}</p></div>` +
    (parts.extra || "") +
    `<div class="cm-list">${cards}</div>${pager}</div>`;
}

function cmPostPage(parts: PostPageParts): string {
  const p = parts.post;
  return `<article><div class="cm-hero">` +
    `<h1 style="font-size:20px;color:var(--cm-accent-2)">> cat ${esc(p.slug)}.md</h1>` +
    `<div style="display:flex;gap:12px;font-size:12px;color:var(--cm-ink-3);margin-top:8px">` +
    `<span>${esc(p.author?.name ?? "unknown")}</span><time>${fmtDate(p.publishedAt)}</time><span>${p.views} reads</span>` +
    `</div>${parts.metaHtml}</div>` +
    `<div class="prose-cms">${parts.bodyHtml}</div>` +
    parts.tagsHtml + parts.shareHtml + parts.commentsHtml +
    `</article>`;
}

function cmPagePage(parts: PagePageParts): string {
  const p = parts.page;
  return `<article><h1 style="font-size:20px;color:var(--cm-accent-2);margin:0 0 24px">> ${esc(p.title)}</h1>` +
    `<div class="prose-cms">${parts.bodyHtml}</div>${parts.commentsHtml}</article>`;
}

const codemanChrome: ThemeChrome = {
  slug: "codeman",
  cssHref: () => themeCssHref("codeman"),
  bodyFix: () => cmBodyFix,
  headExtra: () => "",
  nav: (settings, items) => cmNav(settings, items),
  bodyOpen: (settings, items) =>
    `<div class="cm-crt">` + cmNav(settings, items) +
    `<main id="sk-main"><div class="cm-window"><div class="cm-window-inner">`,
  bodyClose: (settings, footerHtml) =>
    `</div></div></main>${footerHtml}</div>`,
  aside: () => "",
  footer: (settings) => cmFooter(settings),
  home: cmHome,
  listPage: cmListPage,
  postPage: cmPostPage,
  pagePage: cmPagePage,
};

function bmixNav(settings: Record<string, any>, items: MenuItem[]): string {
  const title = esc(settings.siteTitle ?? "");
  const logo = settings.logoUrl
    ? `<img src="${esc(settings.logoUrl)}" alt="${title}">`
    : `<span>${title}</span>`;
  const lis = items
    .map((it, i) => {
      const kids = it.children?.length
        ? `<span class="bm-caret" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>` +
          `<ul class="bm-submenu">${(it.children || [])
            .map(
              (c) =>
                `<li><a href="${esc(c.url)}"${c.target ? ` target="${esc(c.target)}" rel="noopener noreferrer"` : ""}>${esc(c.label)}</a></li>`,
            )
            .join("")}</ul>`
        : "";
      return `<li data-nav-index="${i}"${kids ? ' class="bm-has-sub"' : ""}>` +
        `<a href="${esc(it.url)}"${it.target ? ` target="${esc(it.target)}" rel="noopener noreferrer"` : ""} class="bm-nav-link">${esc(it.label)}</a>${kids}</li>`;
    })
    .join("");
  return `<div class="nav-top">` +
    `<div class="nav at-top" data-rv-navbar>` +
    `<div class="nav-content container-np flex items-center">` +
    `<button type="button" class="mobile-menu-btn flex-col justify-center" aria-label="菜单" aria-expanded="false" data-rv-menu-btn><div></div><div></div><div></div></button>` +
    `<a href="/" class="logo flex items-center">${logo}</a>` +
    `<button type="button" class="mobile-sidebar-btn" aria-label="个人信息" style="margin-left:auto" data-rv-sidebar-btn><div class="sidebar-icon"><div class="sidebar-icon-sidebar"><div></div><div></div><div></div></div></div></button>` +
    `<div class="menu flex-grow justify-end" data-rv-menunav>` +
    `<div class="pf_scroller" data-rv-scroller>` +
    `<ul class="menu" data-level="0">` +
    `<li class="anchor" aria-hidden="true" data-rv-anchor style="transform:translateX(0px);width:0px;opacity:0;left:0"></li>` +
    lis +
    `</ul></div></div>` +
    `<div class="menu-funcs items-center">` +
    `<span class="self-center"><form action="/search" method="get" class="nav-search" role="search"><button type="submit" aria-label="搜索">&#9210;</button><input name="q" placeholder="搜索…" aria-label="搜索"></form></span>` +
    `</div>` +
    `</div></div></div>`;
}

function bmixFooter(settings: Record<string, any>, widgetsHtml: string): string {
  const year = new Date().getFullYear();
  const copyright = settings.footerText || `Designed &amp; Coded by oboext © ${year} ${settings.siteTitle}`;
  return `<footer style="padding:64px 0;font-size:12px;position:relative">` +
    (widgetsHtml ? `<div class="container-np" style="padding:0 40px;margin-bottom:24px">${widgetsHtml}</div>` : "") +
    `<div class="container-np" style="padding:0 40px">` +
    `<div style="text-align:right;color:var(--muted)">${copyright}</div>` +
    (settings.icpNumber ? `<div style="margin-top:16px;text-align:right"><a href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">${esc(settings.icpNumber as string)}</a></div>` : "") +
    `</div></footer>`;
}

const BMIX_PALETTE = ["#3b6ea5","#5f7ad1","#e0853b","#7a5fa8","#3aa37f","#b5548f","#c75f5f","#58595b","#2d8f9e","#6f8f3a"];
function _hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return Math.abs(h); }
function _hex2rgb(hex: string): [number, number, number] { let h = hex.replace(/#/g, ""); if (h.length === 6) return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]; return [0, 0, 0]; }
function _rgb2hsl(r: number, g: number, b: number): [number, number, number] { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); const L = (max + min) / 2; if (max === min) return [0, 0, L * 100]; const d = max - min; const v = L > 0.5 ? d / (2 - max - min) : d / (max + min); let h: number; switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; } h /= 6; return [(h % 1) * 360, v * 100, L * 100]; }
function _hsl2rgb(h: number, s: number, l: number): [number, number, number] { h /= 360; s /= 100; l /= 100; let r: number, g: number, b: number; if (s === 0) { r = g = b = l; } else { const hue2rgb = (p: number, q: number, t: number) => { let x = t; if (x < 0) x += 1; if (x > 1) x -= 1; if (x < 1 / 6) return p + (q - p) * 6 * x; if (x < 1 / 2) return q; if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6; return p; }; const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3); } return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]; }
function _rgb2hex(r: number, g: number, b: number): string { const d = (u: number) => { let x = Math.round(u); if (x > 255) x = 255; if (x < 0) x = 0; const s2 = x.toString(16); return s2.length < 2 ? "0" + s2 : s2; }; return "#" + d(r) + d(g) + d(b); }
function _hx(h: number, s: number, l: number): string { const [r, g, b] = _hsl2rgb(h, s, l); return _rgb2hex(r, g, b); }
function _rg(h: number, s: number, l: number, a: number): string { const [r, g, b] = _hsl2rgb(h, s, l); return `rgba(${r},${g},${b},${a})`; }
function _mix(v: number, range: [number, number]): number { return (v / 100) * (range[1] - range[0]) + range[0]; }

/** Deterministic per-card glass tone (mirror of cardVars.cardTone + color.toneFromColor). */
function bmixCardTone(seed: string, fallbackIndex: number, bgAlpha = 1): { vars: Record<string, string>; dark: boolean } {
  const base = BMIX_PALETTE[_hash(seed || String(fallbackIndex)) % BMIX_PALETTE.length];
  const [pr, pg, pb] = _hex2rgb(base);
  const [cH, cS, cL] = _rgb2hsl(pr, pg, pb);
  const dark = cL < 65;
  let mS = _mix(cS, cS < 18 ? [0, 14] : [38, 76]); const mL = _mix(cL, [24, 38]);
  if (cS < 18) mS = Math.min(mS, 14);
  const accent = _rg(cH, 40, 80, .12);
  const shDark = "rgba(255,255,255,.2) .1053em .1053em, rgba(0,0,0,.2) .1842em .1842em .2em";
  const shLight = `-1px -1px var(--white-opacity-8), .1053em .1053em ${accent}, .1842em .1842em .1316em ${accent}`;
  const imageShadow = _rg(cH, Math.min(100, 40 * 99), Math.min(100, 80 * 1.1), .15);
  if (dark) return { vars: { "--default": "rgba(255,255,255,.85)", "--title-color": "rgba(255,255,255,.96)", "--control-color": "rgba(255,255,255,.75)", "--bg": _rg(cH, cS, cL, bgAlpha), "--text-shadow": shDark, "--text-shadow-dark": shDark, "--image-shadow": imageShadow }, dark: true };
  return { vars: { "--default": _hx(cH, mS, mL), "--title-color": _hx(cH, mS, mL), "--control-color": _hx(cH, Math.min(100, mS * 1.1), 40), "--bg": _rg(cH, cS, cL, bgAlpha), "--text-shadow": shLight, "--text-shadow-dark": shDark, "--image-shadow": imageShadow }, dark: false };
}

function bmixSplitTitle(raw: string): { title1: string; title2: string } {
  const a = raw.split(" · ");
  if (a.length === 2) return { title1: a[0], title2: a[1] };
  const m = raw.match(/\[[^\]]+\]/);
  if (m) return { title1: raw.replace(m[0], ""), title2: m[0].slice(1, -1) };
  return { title1: raw, title2: "" };
}

function bmixIc(icon: string, size: number, marginRight = 6): string {
  const paths: Record<string, string> = {
    bookmark: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
    heart: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
    comments: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
    eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z",
  };
  const circle = icon === "eye" ? `<circle cx="12" cy="12" r="3"/>` : "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:${marginRight}px">${circle}<path d="${paths[icon] || paths.bookmark}"/></svg>`;
}

function bmixPostCard(p: PostView, idx: number): string {
  const t = bmixCardTone(p.slug || p.url, idx, 1);
  const darkCls = t.dark ? " is-dark" : "";
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(";");
  const { title1, title2 } = bmixSplitTitle(p.title);
  const img = p.featuredImage
    ? `background-image:url('${p.featuredImage.replace(/'/g, "%27")}')`
    : "background-image:linear-gradient(135deg,#dce8f7,#c9ddf5 60%,#bcd6f3)";
  const tags = (p.tags || []).slice(0, 3).map((tg) => tg.name).join(" · ") || "&nbsp;";
  return `<article class="post-card"><div class="post-card-wrapper${darkCls}" style="transform:perspective(720px) scale3d(1,1,1);${vars}">` +
    `<a href="${esc(p.url)}" aria-label="${esc(p.title)}" class="card card-container${darkCls}">` +
    `<span class="main-title type-1"><div>${esc(title1)}</div>${title2 ? `<div>${esc(title2)}</div>` : ""}</span>` +
    `<span class="block img" style="${img}"></span><span class="sr-only">${esc(p.title)}</span>` +
    `</a><div class="highlight"></div></div>` +
    `<div class="metas relative"><div class="tags text-center text-xs text-primary-gray text-embossed">${bmixIc("bookmark", 12)}${tags}</div>` +
    `<div class="absolute inset-0 infos flex gx-5 gy-2 justify-center flex-wrap text-xs">` +
    `<span class="inline-block text-error text-bulge-error">${bmixIc("heart", 12)} ${p.likes ?? 0}</span>` +
    `<span class="inline-block text-primary text-bulge-primary">${bmixIc("comments", 12)} ${p.commentsCount ?? 0}</span>` +
    `<span class="inline-block text-success text-bulge-success">${bmixIc("eye", 12)} ${p.views ?? 0}</span>` +
    `</div></div></article>`;
}

function bmixSectionTitle(text: string): string {
  return `<div class="cat-title flex items-center large"><div class="icon flex default mr-5 ml-2"></div><div class="content text-primary-gray text-bulge-primary-gray">${esc(text)}</div></div>`;
}

function bmixPager(page: number, total: number, hrefFor: (p: number) => string): string {
  if (total <= 1) return "";
  const link = (href: string, label: string) => `<a href="${esc(href)}" style="color:var(--primary-color);text-decoration:none;padding:4px 11px;border-radius:6px;display:inline-block">${label}</a>`;
  const nums: string[] = [];
  for (let p = 1; p <= total; p++) {
    nums.push(p === page
      ? `<li style="background:var(--primary-color);color:#fff;border-radius:6px;padding:4px 11px">${p}</li>`
      : `<li>${link(hrefFor(p), String(p))}</li>`);
  }
  return `<ul class="main-pagination" style="display:flex;gap:6px;list-style:none;padding:28px 0 8px;justify-content:center;align-items:center;flex-wrap:wrap">` +
    (page > 1 ? `<li>${link(hrefFor(page - 1), "&laquo;")}</li>` : "") +
    nums.join("") +
    (page < total ? `<li>${link(hrefFor(page + 1), "&raquo;")}</li>` : "") +
    `</ul>`;
}

function bmixHome(parts: HomeParts): string {
  const all = [...parts.hero, ...parts.latest].slice(0, 8);
  const cards = all.map((p, i) => bmixPostCard(p, i)).join("");
  const inner = all.length
    ? `<div class="cat-title flex items-center large"><div class="icon flex default mr-5 ml-2"></div><div class="content text-primary-gray text-bulge-primary-gray">近期文章</div></div><div class="recent-articles">${cards}</div>`
    : `<p class="text-primary-gray" style="padding:24px">还没有已发布的文章。去后台发布一篇，或先导入示例内容吧。</p>`;
  return `<div class="home"><div class="content-wrapper flex container-np line reverse">` +
    `<div class="main-content">${inner}</div>` +
    `</div></div>`;
}

function bmixListPage(parts: ListParts): string {
  const cards = parts.items.map((p, i) => bmixPostCard(p, i)).join("");
  const pager = parts.showPager !== false ? bmixPager(parts.page, parts.totalPages, parts.hrefFor) : "";
  return `<div class="home"><div class="container-np">` +
    bmixSectionTitle(parts.title) +
    (parts.sub ? `<p class="text-primary-gray" style="padding:0 2px">${esc(parts.sub)}</p>` : "") +
    (parts.extra || "") +
    `<div class="list-grid">${cards}</div>${pager}` +
    `</div></div>`;
}

function bmixPostPage(parts: PostPageParts): string {
  const p = parts.post;
  return `<article class="container-np" style="padding:24px 40px;max-width:860px"><header style="margin-bottom:24px">` +
    `<h1 style="font-size:28px;font-weight:700;line-height:1.3;margin:0">${esc(p.title)}</h1>` +
    `<div style="margin-top:12px;display:flex;gap:16px;font-size:13px;color:var(--muted)">` +
    `<span>${esc(p.author?.name ?? "未知作者")}</span><time>${fmtDate(p.publishedAt)}</time><span>${p.views} 阅读</span>` +
    `</div>${parts.metaHtml}</header>` +
    (p.featuredImage ? `<img src="${esc(p.featuredImage)}" alt="${esc(p.title)}" style="width:100%;border-radius:16px;margin-bottom:24px">` : "") +
    `<div class="prose-cms">${parts.bodyHtml}</div>` +
    parts.tagsHtml + parts.shareHtml + parts.commentsHtml +
    `</article>`;
}

function bmixPagePage(parts: PagePageParts): string {
  const p = parts.page;
  return `<article class="container-np" style="padding:24px 40px;max-width:860px">` +
    `<h1 style="font-size:28px;font-weight:700;margin:0 0 24px">${esc(p.title)}</h1>` +
    `<div class="prose-cms">${parts.bodyHtml}</div>${parts.commentsHtml}</article>`;
}

const BLUEMIX_VARS = `
:root{
--primary-color:#1f8bff;--primary-dark:#32465e;--primary-gray:#5578a1;
--white-default:#fff;--gray-5:#e5e9ef;--gray-6:#eaeaec;--gray-9:#f2f7fc;
--text-color:#324057;--text-color-2:#475669;--text-color-3:#758397;
--border-color:#D3DCE6;--border-color-2:#E5E9F2;--border-color-3:#EFF2F7;
--analogous-color:#33bbff;
--success-color:#67c23a;--error-color:#f56c6c;--warning-color:#e6a23c;
--primary-opacity-05:rgba(31,139,255,.05);--primary-opacity-1:rgba(31,139,255,.1);
--primary-opacity-15:rgba(31,139,255,.15);--primary-opacity-2:rgba(31,139,255,.2);
--primary-opacity-3:rgba(31,139,255,.3);--primary-opacity-4:rgba(31,139,255,.4);
--primary-opacity-5:rgba(31,139,255,.5);--primary-opacity-55:rgba(31,139,255,.55);
--primary-opacity-6:rgba(31,139,255,.6);
--primary-gray-opacity-05:rgba(85,120,161,.05);--primary-gray-opacity-1:rgba(85,120,161,.1);
--primary-gray-opacity-15:rgba(85,120,161,.15);--primary-gray-opacity-2:rgba(85,120,161,.2);
--primary-gray-opacity-25:rgba(85,120,161,.25);--primary-gray-opacity-3:rgba(85,120,161,.3);
--primary-gray-opacity-4:rgba(85,120,161,.4);--primary-gray-opacity-45:rgba(85,120,161,.45);
--primary-gray-opacity-5:rgba(85,120,161,.5);--primary-gray-opacity-7:rgba(85,120,161,.7);
--primary-gray-opacity-75:rgba(85,120,161,.75);
--white-opacity-0:rgba(255,255,255,0);--white-opacity-15:rgba(255,255,255,.15);
--white-opacity-2:rgba(255,255,255,.2);--white-opacity-25:rgba(255,255,255,.25);
--white-opacity-3:rgba(255,255,255,.3);--white-opacity-35:rgba(255,255,255,.35);
--white-opacity-5:rgba(255,255,255,.5);--white-opacity-6:rgba(255,255,255,.6);
--white-opacity-65:rgba(255,255,255,.65);--white-opacity-7:rgba(255,255,255,.7);
--white-opacity-75:rgba(255,255,255,.75);--white-opacity-8:rgba(255,255,255,.8);
--white-opacity-85:rgba(255,255,255,.85);--white-opacity-9:rgba(255,255,255,.9);
--gray-0:#001e3c;--gray-1:#17212b;--gray-2:#32404f;--gray-3:#8492a6;--gray-4:#d3dce6;
--gray-opacity-0:rgba(0,30,60,0);--gray-opacity-05:rgba(0,30,60,.05);--gray-opacity-1:rgba(0,30,60,.1);
--gray-opacity-15:rgba(0,30,60,.15);--gray-opacity-2:rgba(0,30,60,.2);--gray-opacity-25:rgba(0,30,60,.25);
--gray-opacity-3:rgba(0,30,60,.3);--gray-opacity-35:rgba(0,30,60,.35);--gray-opacity-4:rgba(0,30,60,.4);
--gray-opacity-5:rgba(0,30,60,.5);--gray-opacity-55:rgba(0,30,60,.55);--gray-opacity-6:rgba(0,30,60,.6);
--card-radius:12px;--card-padding:6px;--sidebar-width:340px;--nav-height:60px;
--text-shadow:-1px -1px var(--white-opacity-7),2px 2px 3px var(--primary-opacity-4);
--text-shadow-dark:0 1px 3px rgba(0,0,0,.6),0 0 2px rgba(0,0,0,.5);
}`;

const bluemixChrome: ThemeChrome = {
  slug: "bluemix",
  cssHref: () => themeCssHref("bluemix"),
  bodyFix: () => `body{background:#e5e9ef!important;color:var(--text-color-2,#324057)!important;}html{background:#e5e9ef!important;}`,
  headExtra: () => `<style id="rv-theme-bluemix-vars">${BLUEMIX_VARS}</style>`,
  nav: (settings, items) => bmixNav(settings, items),
  bodyOpen: (settings, items) => `<div class="th-bluemix">` + bmixNav(settings, items) + `<main id="sk-main">`,
  bodyClose: (settings, footerHtml) => `</main>${footerHtml}</div>`,
  aside: () => "",
  footer: (settings, widgetsHtml) => bmixFooter(settings, widgetsHtml),
  home: bmixHome,
  listPage: bmixListPage,
  postPage: bmixPostPage,
  pagePage: bmixPagePage,
};

const registry = new Map<string, ThemeChrome>();
registry.set("skyscraper", skyscraperChrome);
registry.set("default", defaultChrome);
registry.set("pseudolinear", pseudolinearChrome);
registry.set("codeman", codemanChrome);
registry.set("bluemix", bluemixChrome);

export function getThemeChrome(slug: string): ThemeChrome {
  return registry.get(slug) ?? skyscraperChrome;
}
