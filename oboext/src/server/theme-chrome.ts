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
import { mimeFor } from "./storage.js";

export interface ThemeChrome {
  slug: string;
  cssHref(): string;
  /**
   * Raw CSS that must apply as early as possible (the theme's base
   * background/colour, before the external stylesheet lands). Contract: this
   * returns CSS **declarations only** — it is wrapped in a `<style>` element by
   * `bodyFixHtml()` before being injected via `{@html ...}`. Returning a bare
   * CSS string straight into the layout renders it as a visible text node
   * (every theme used to leak `body{background:…}` at the top of the page).
   */
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
  icon?: string | null;
  children?: MenuItem[];
};

function cssUrl(v: string): string {
  return `url(&quot;${String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;")}&quot;)`;
}

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
  tags?: TaxRef[];

  total?: number;

  widgets?: string;
  settings: Record<string, unknown>;
  recent?: PostView[];
  sections?: { row: { category: TaxRef; title: string; icon: string | null }; posts: PostView[] }[];
  rankings?: { most_comments: RankPost[]; most_likes: RankPost[]; most_reads: RankPost[] } | null;
  rankTabs?: { labels: Record<string, string>; order: string[]; defaultTab: string };
  themeSettings?: Record<string, unknown>;
  blogIndex?: string;
  showHero?: boolean;
  bannerMax?: number;
  recentCount?: number;
};

export type RankPost = {
  id: number;
  url: string;
  title: string;
  thumbnail: string | null;
  likes: number;
  comments: number;
  views: number;
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
  /** bluemix list page extras (ignored by the other themes) */
  hero?: PostView[];
  cats?: TaxRef[];
  blogIndex?: string;
  bannerMax?: number;
  activeHref?: string;

  variant?: "blog" | "category" | "search" | "term";

  widgets?: string;

  drawerPosts?: PostView[];

  sidebarData?: { posts: PostView[]; tags: TaxRef[]; cats: TaxRef[]; showCatIcons?: boolean };

  settings?: Record<string, unknown>;
  themeSettings?: Record<string, unknown>;

  titleIcon?: string | null;

  titleDesc?: string;

  emptyHint?: string;

  total?: number;

  query?: string;
};

export type PostPageParts = {
  post: PostView;
  bodyHtml: string;
  related: PostView[];

  relatedTaxonomy?: PostView[];

  popular?: PostView[];

  random?: PostView[];
  commentsHtml: string;
  metaHtml: string;

  defMetaHtml?: string;
  tagsHtml: string;

  defTagsHtml?: string;
  shareHtml: string;

  blogIndex?: string;

  widgets?: string;

  postBottom?: string;

  sidebarWidgets?: string;

  canonical?: string;

  sidebarData?: { posts: PostView[]; tags: TaxRef[]; cats: TaxRef[]; showCatIcons?: boolean };

  settings?: Record<string, unknown>;
};

export type PagePageParts = {
  page: PageView;
  bodyHtml: string;
  recent: PostView[];
  commentsHtml: string;

  widgets?: string;
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

/**
 * /public/<file> with an mtime cache-buster. The theme JS files are served
 * straight off disk, so during development an edit + reload can silently keep
 * running the previous copy (the browser has no reason to revalidate). Stamping
 * the mtime makes every edit take effect immediately.
 */
export function publicAssetHref(file: string): string {
  try {
    const st = fs.statSync(path.join(process.cwd(), "oboext", "public", file));
    return `/public/${file}?v=${Math.round(st.mtimeMs)}`;
  } catch {
    return `/public/${file}`;
  }
}

const GLOBALS_BODY_UTILITIES = `.min-h-screen{min-height:100vh}
.bg-\\[var\\(--bg\\)\\]{background-color:var(--bg)}
.text-\\[var\\(--text\\)\\]{color:var(--text)}
.antialiased{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.py-16{padding-block:64px}
.mt-4{margin-top:16px}
.hidden{display:none}
.group:hover .group-hover\\:block{display:block}
@media (min-width:640px){.sm\\:block{display:block}.sm\\:hidden{display:none}.sm\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:768px){.md\\:block{display:block}.md\\:hidden{display:none}}
@media (min-width:1024px){.lg\\:hidden{display:none}.lg\\:grid-cols-\\[1fr_300px\\]{grid-template-columns:1fr 300px}}
@media (min-width:1280px){.xl\\:hidden{display:none}}
`;

const SHARED_FORM_BASELINE = `
/* ===========================================================================
   Built-in comment form — shared structural baseline
   Markup: src/server/render.ts builtinCommentsHtml (.comment-form). Selectors
   stay low-specificity on purpose: bluemix / codeman / pseudolinear ship their
   own higher-specificity overrides; this block only guarantees a usable form
   (bordered .input box, icon guest row, right-aligned submit) in themes
   without form CSS — default / skyscraper —
   using the generic theme tokens (--surface, --border, --accent, …).
   =========================================================================== */
.comment-form{ display:block; margin:20px 0; }
.comment-form .input{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:var(--radius);
  transition:border-color .15s ease, box-shadow .15s ease;
}
.comment-form .input:hover{ border-color:var(--accent); }
.comment-form .input.is_focused{
  border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
}
.comment-form textarea{
  display:block; width:100%; height:7em;
  padding:12px 16px; font-size:16px; font-family:inherit; line-height:1.6;
  resize:vertical; outline:none; border:0; background:transparent;
  color:var(--text);
}
.comment-form textarea::-moz-placeholder{ color:var(--muted); }
.comment-form textarea::placeholder{ color:var(--muted); }
.comment-form .funcs{ display:flex; margin-top:8px; position:relative; }
/* >button: direct trigger only; the emoji popover is nested inside .funcs
   and its inner buttons must keep the verbatim .emoji-panel styles */
.comment-form .funcs>button{
  display:inline-flex; align-items:center; justify-content:center;
  width:36px; height:32px; padding:0; border:0; cursor:pointer;
  background:transparent; color:var(--muted); transition:color .15s ease;
}
.comment-form .funcs>button:hover{ color:var(--accent); }

.comment-form .guest-info{ display:flex; gap:8px; }
.comment-form .guest-info .item{ position:relative; flex:1 1 0; min-width:0; }
.comment-form .comment-field{
  width:100%; height:34px; padding:0 10px 0 34px;
  font-size:13px; font-family:inherit; outline:none;
  background:var(--surface, #fff);
  border:1px solid var(--border, rgba(144,147,153,.35)); border-left:0;
  border-radius:0 8px 8px 0; color:var(--text, #1f2937);
  box-shadow:inset 0 1px 2px rgba(31,45,61,.05);
  transition:border-color .15s ease, box-shadow .15s ease;
}
.comment-form .comment-field:focus{
  border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent), inset 0 1px 2px rgba(31,45,61,.05);
}
.comment-form .comment-field::-moz-placeholder{ color:var(--muted); }
.comment-form .comment-field::placeholder{ color:var(--muted); }
.comment-form .guest-info .item i{
  position:absolute; left:0; top:0; bottom:0; width:34px;
  display:flex; align-items:center; justify-content:center;
  font-style:normal; pointer-events:none; color:var(--muted);
  background:color-mix(in srgb, var(--muted, #909399) 8%, var(--surface, #fff));
  border:1px solid var(--border, rgba(144,147,153,.35)); border-right:0;
  border-radius:8px 0 0 8px;
}
.comment-form .comment-field:focus + i{
  color:var(--accent); border-color:var(--accent);
}
@media (max-width:650.5px){
  .comment-form .guest-info{ flex-direction:column; }
}
.comment-form .form-actions{
  display:flex; justify-content:flex-end; align-items:center; gap:8px;
}
.comment-form .cancel{
  display:inline-flex; align-items:center; gap:4px;
  padding:8px 10px; border:0; background:transparent; cursor:pointer;
  font-size:14px; font-family:inherit; color:var(--muted);
  animation:sf-cancel-in .2s cubic-bezier(.34,1.4,.64,1);
}
@keyframes sf-cancel-in{ from{ opacity:0; transform:translateX(8px);} to{ opacity:1; transform:none; } }
.comment-form .cancel:hover{ color:var(--text); }
.comment-form .btn-submit{
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  padding:9px 18px; border:0; border-radius:var(--radius);
  background:var(--accent); color:var(--accent-text, #fff);
  font-size:14px; font-weight:600; font-family:inherit; cursor:pointer;
  transition:filter .15s ease;
}
.comment-form .btn-submit:hover{ filter:brightness(1.08); }
.comment-form .btn-submit:disabled{ opacity:.6; cursor:default; }
.sf-comment-close{ color:var(--muted); font-size:14px; padding:8px 0; }

/* Logged-in account bar shown above the comment box (guest inputs hidden) */
.sf-comment-me{ display:flex; align-items:center; gap:10px; margin:0 0 10px; width:-moz-fit-content; width:fit-content; max-width:100%; }
.sf-comment-me-avatar{
  width:34px; height:34px; border-radius:50%; flex-shrink:0;
  display:inline-flex; align-items:center; justify-content:center;
  background:var(--accent); color:var(--accent-text, #fff); font-size:15px; font-weight:600;
}
.sf-comment-me-meta{ display:flex; flex-direction:column; min-width:0; }
.sf-comment-me-name{ font-size:14px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sf-comment-me-email{ font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.comment-form .funcs button.is-active{ color:var(--accent); }
.emoji-panel{
  position:absolute; left:0; bottom:calc(100% + 6px); z-index:30;
  padding:1em; font-size:15px; border-radius:10px;
  background:var(--surface, #fff);
  border:1px solid var(--border, rgba(0,0,0,.12));
  box-shadow:0 10px 28px rgba(0,0,0,.18);
}
.emoji-panel:before{ content:none; }
.emoji-panel .panel{
  width:290px; height:300px; margin:0 -10px;
  overflow-y:auto; scroll-behavior:smooth; position:relative;
}
.emoji-panel .emoji-grid{ display:grid; grid-template-columns:repeat(7,1fr); }
.emoji-panel .tabs{
  display:flex;
  border-top:1px solid var(--border, rgba(0,0,0,.1));
  margin:1px -14px -14px;
}
.emoji-panel .tabs button{
  flex:1; padding:10px 0; font-size:20.5px; line-height:1; color:inherit;
  border:none; background:transparent; cursor:pointer;
  opacity:.4; transition:.35s; filter:grayscale(1);
  margin-top:-1px; position:relative;
}
.emoji-panel .tabs button.active{
  opacity:1; box-shadow:0 2px var(--primary-color,var(--accent)) inset; filter:none;
}
.emoji-panel .tabs button.active:before{
  content:""; display:block; width:0; height:0; position:absolute; top:1px; left:calc(50% - 4px);
  border-top:4px solid var(--primary-color,var(--accent));
  border-left:4px solid transparent; border-right:4px solid transparent;
}
.emoji-panel .tabs button:hover{ opacity:1; filter:none; }
.emoji-panel .title{
  padding:3px 10px; color:var(--muted, #666);
  font-size:12px; font-weight:600;
  background:color-mix(in srgb, var(--muted, #888) 8%, var(--surface, #fff));
  border-radius:6px;
  margin:6px; position:sticky; top:0;
}
.emoji-panel .emoji{
  height:42px; border:none; padding:0; font-size:22px; line-height:1;
  background:transparent; border-radius:.25em; cursor:pointer; transition:.35s;
}
.emoji-panel .emoji:hover{
  background:var(--primary-opacity-2,color-mix(in srgb,var(--accent) 20%,transparent));
  text-shadow:0 3px 3px var(--gray-opacity-2,rgba(0,0,0,.2)); transition:0s;
}
@media (max-width:650.5px){
  .emoji-panel .panel{ width:min(290px, calc(100vw - 78px)); }
}

.emoji-panel-wrap{ display:contents; }
.emoji-panel-wrap .emoji-panel{
  transform-origin:0 100%;
  transition:opacity .18s ease, transform .22s cubic-bezier(.34,1.56,.64,1);
  will-change:opacity, transform;
}
.emoji-panel-wrap:not(.is-in) .emoji-panel{
  opacity:0;
  transform:translateY(10px) scale(.88);
  pointer-events:none;
}
`;

export function themeCssContent(slug: string): string {
  if (slug === "skyscraper") return "";
  const main = readThemeCss(slug, slug + ".css");
  let css = main.css;
  try {
    const extra = readThemeCss(slug, slug + "-extra.css");
    if (extra.css) css += "\n" + extra.css;
  } catch { /* no extra */ }
  
  
  return SHARED_FORM_BASELINE + GLOBALS_BODY_UTILITIES + css;
}

export function serveThemeAsset(urlPath: string, method = "GET"): Response {
  const notFound = () =>
    new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  const forbidden = () =>
    new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  try {
    const rel = decodeURIComponent(urlPath.replace(/^\/theme-assets\//, ""));
    const segments = rel.split("/").filter(Boolean);
    if (segments.length < 2) return notFound();
    const themesRoot = path.resolve(THEMES_DIR);
    const target = path.resolve(themesRoot, segments[0], "assets", ...segments.slice(1));
    if (!target.startsWith(themesRoot + path.sep)) return forbidden();
    const st = fs.statSync(target);
    if (st.isDirectory()) return notFound();
    const data = fs.readFileSync(target);
    return new Response(method === "HEAD" ? null : new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": mimeFor(target),
        "content-length": String(data.length),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return notFound();
  }
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
    R.postPage(parts.post, parts.related, parts.commentsHtml, [], parts.bodyHtml, parts.blogIndex),
  pagePage: (parts) =>
    R.pagePage(parts.page, parts.recent, parts.commentsHtml, parts.bodyHtml),
};

const defaultBodyFix = `<style id="rv-body-fix">body{background:var(--bg,#09090b);color:var(--text,#f4f4f5)}</style>`;

function defaultMenuUl(items: MenuItem[], cls: string): string {
  if (!items.length) return "";
  const link = (it: MenuItem, extra: string) =>
    `<a href="${esc(it.url)}"${it.target && it.target !== "_self" ? ` target="${esc(it.target)}" rel="noopener"` : ""} class="flex items-center gap-1.5 px-3 py-2 text-sm text-zinc-300 transition ${extra}">${esc(it.label)}</a>`;
  const lis = items
    .map((it) => {
      const kids = it.children?.length
        ? `<ul class="absolute left-0 top-full z-20 hidden min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl group-hover:block">` +
          (it.children || [])
            .map((c) => `<li>${link(c, "hover:bg-white/5 hover:text-white")}</li>`)
            .join("") +
          `</ul>`
        : "";
      return `<li class="group relative">${link(it, "hover:text-white")}${kids}</li>`;
    })
    .join("");
  return `<ul class="${cls}">${lis}</ul>`;
}

function defaultNav(settings: Record<string, any>, items: MenuItem[]): string {
  const title = esc(settings.siteTitle ?? "");
  const headingClass = "text-zinc-100";
  const brandLink =
    settings.logoUrl
      ? `<img src="${esc(settings.logoUrl)}" alt="${title}" class="h-7 w-auto">`
      : `<span class="flex h-8 w-8 items-center justify-center rounded-lg" style="background:var(--accent);color:var(--accent-text)">${(title || "").charAt(0).toUpperCase()}</span>${title}`;
  const menu = defaultMenuUl(items, "flex flex-wrap items-center");

  return `<div class="theme-root relative flex min-h-screen flex-col">` +
    `<header class="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]">` +
    `<div class="relative mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">` +
    `<a href="/" class="flex items-center gap-2 text-lg font-bold tracking-tight ${headingClass}">${brandLink}</a>` +
    `<nav class="ml-2 hidden flex-1 md:block">${menu}</nav>` +
    `<form action="/search" method="get" class="ml-auto hidden sm:block"><div class="relative">` +
    lucideSvg("search", 16, "pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]") +
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

  const cls = "rounded-full bg-[var(--accent)]/15 px-2.5 py-0.5 text-[var(--accent)]";
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
    `<span class="inline-flex items-center gap-1">${lucideSvg("user", 13)}${author}</span>` +
    `<span class="inline-flex items-center gap-1">${lucideSvg("calendar", 13)}${fmtDate(p.publishedAt)}</span>` +
    (p.commentsCount > 0 ? `<span class="inline-flex items-center gap-1">${lucideSvg("message-circle", 13)}${p.commentsCount} 评论</span>` : "") +
    `</div></div></article>`;
}

function defaultHome(parts: HomeParts): string {
  const siteTitle = esc((parts.settings.siteTitle as string) ?? "");

  const tagline = parts.settings.tagline ? `<p class="mt-3 text-base text-[var(--muted)]">${esc(parts.settings.tagline as string)}</p>` : "";
  const desc = parts.settings.siteDescription
    ? `<p class="mx-auto mt-3 max-w-2xl text-sm text-[var(--muted)]">${esc(parts.settings.siteDescription as string)}</p>`
    : "";
  const hero = `<section class="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-gradient-to-br from-[var(--surface)] to-[var(--bg)] px-8 py-12 text-center">` +
    lucideSvg("sparkles", 28, "mx-auto mb-4 text-[var(--accent)]") +
    `<h1 class="text-4xl font-bold tracking-tight text-[var(--text)]">${siteTitle}</h1>${tagline}${desc}</section>`;
  const all = [...parts.hero, ...parts.latest];
  const featured = all[0];
  const rest = all.slice(1);
  let featuredHtml = `<p class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-[var(--muted)]">还没有已发布的文章。</p>`;
  if (featured) {
    const cats = ((featured.categories || []).slice(0, 3).map(defaultCatPill)).join("");
    featuredHtml = `<article class="group overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)]">` +
      (featured.featuredImage
        ? `<a href="${esc(featured.url)}" class="block aspect-[21/9] overflow-hidden"><img src="${esc(featured.featuredImage)}" alt="${esc(featured.title)}" class="h-full w-full object-cover transition duration-300 group-hover:scale-105" loading="lazy"></a>`
        : "") +
      `<div class="p-6">${cats ? `<div class="mb-2 flex flex-wrap gap-2 text-xs">${cats}</div>` : ""}` +
      `<h2 class="text-2xl font-bold leading-snug text-[var(--text)]"><a href="${esc(featured.url)}" class="transition group-hover:text-[var(--accent)]">${esc(featured.title)}</a></h2>` +
      `<span class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)]">${lucideSvg("sparkles", 13)} 推荐阅读</span>` +
      (featured.excerpt ? `<p class="mt-3 line-clamp-3 text-sm text-[var(--muted)]">${esc(featured.excerpt)}</p>` : "") +
      `</div></article>`;
  }
  const grid = rest.map((p, i) => defaultPostCard(p, i)).join("");

  return `<div class="space-y-10">${hero}` +
    `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><div><div class="space-y-6">${featuredHtml}` +
    (rest.length ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">${grid}</div>` : "") +
    `</div></div>${defaultAside(parts.cats || [], parts.tags || [], [...parts.hero, ...parts.latest].slice(0, 5), parts.settings, (parts.themeSettings as Record<string, any> | undefined)?.useCustomIcons === true)}</div></div>`;
}

function defaultAside(cats: TaxRef[], tags: TaxRef[], recent: PostView[], settings: Record<string, unknown>, showCatIcons = false): string {
  const catLis = cats.map((c) =>
    `<li><a href="${esc(c.url)}" class="flex items-center gap-1.5 text-[var(--text)] hover:text-[var(--accent)]">${showCatIcons && c.icon ? lucideSvg(c.icon, 14, "text-[var(--accent)]") : ""}${esc(c.name)}</a></li>`).join("");
  const recentLis = recent.map((p) =>
    `<li><a href="${esc(p.url)}" class="text-[var(--text)] hover:text-[var(--accent)]">${esc(p.title)}</a><p class="text-xs text-[var(--muted)]">${fmtDate(p.publishedAt)}</p></li>`).join("");
  const tagPills = tags.map((t) =>
    `<a href="${esc(t.url)}" class="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]">#${esc(t.name)}</a>`).join("");
  const cardHead = (icon: string, label: string) =>
    `<h3 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">${lucideSvg(icon, 15)}${label}</h3>`;
  return `<aside class="space-y-6">` +
    `<form action="/search" method="get" class="block"><div class="relative">` +
    lucideSvg("search", 16, "pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]") +
    `<input name="q" placeholder="搜索文章…" class="w-full rounded-full border border-[var(--border)] bg-[var(--surface)] py-2 pl-9 pr-4 text-sm outline-none focus:border-[var(--accent)]">` +
    `</div></form>` +
    `<div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">${cardHead("folder", "分类")}` +
    `<ul class="space-y-1 text-sm">${catLis || `<li class="text-[var(--muted)]">暂无分类</li>`}</ul></div>` +
    `<div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">${cardHead("tags", "标签")}` +
    `<div class="flex flex-wrap gap-2">${tagPills || `<span class="text-xs text-[var(--muted)]">暂无标签</span>`}</div></div>` +
    `<div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">${cardHead("clock", "最新文章")}` +
    `<ul class="space-y-2 text-sm">${recentLis}</ul></div>` +
    `</aside>`;
}

function defaultPager(page: number, totalPages: number, hrefFor: (p: number) => string): string {
  if (totalPages <= 1) return "";
  const windowSize = 5;
  let start = Math.max(1, page - Math.floor(windowSize / 2));
  let end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const pages: number[] = [];
  for (let p = start; p <= end; p++) pages.push(p);
  const cell = (p: number) => {
    const active = p === page;
    return `<a href="${esc(hrefFor(p))}"${active ? ' aria-current="page"' : ""} class="min-w-9 rounded-lg border px-3 py-2 text-center text-sm transition ${active
      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
      : "border-[var(--border)] text-zinc-300 hover:border-[var(--accent)] hover:text-[var(--accent)]"}">${p}</a>`;
  };
  const edge = (label: string, icon: string, p: number) =>
    `<a href="${esc(hrefFor(p))}" class="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-zinc-300 transition hover:border-[var(--accent)] hover:text-[var(--accent)]">${icon}${label}</a>`;
  let out = `<nav class="mt-10 flex items-center justify-center gap-1.5" aria-label="分页">`;
  if (page > 1) out += edge("上一页", lucideSvg("chevron-left", 15), page - 1);
  if (start > 1) {
    out += cell(1);
    if (start > 2) out += `<span class="px-1 text-zinc-500">…</span>`;
  }
  out += pages.map(cell).join("");
  if (end < totalPages) {
    if (end < totalPages - 1) out += `<span class="px-1 text-zinc-500">…</span>`;
    out += cell(totalPages);
  }
  if (page < totalPages) out += edge("下一页", lucideSvg("chevron-right", 15), page + 1);
  return out + `</nav>`;
}

/** mirror components/shared/Breadcrumb.tsx。 */
function defaultBreadcrumb(items: { label: string; href?: string }[]): string {
  if (!items.length) return "";
  const spans = items
    .map((c, i) => {
      const last = i === items.length - 1;
      const inner = c.href && !last
        ? `<a href="${esc(c.href)}" class="transition hover:text-[var(--accent)]">${esc(c.label)}</a>`
        : `<span class="${last ? "text-zinc-300" : ""}">${esc(c.label)}</span>`;
      return `<span class="inline-flex items-center gap-1">${inner}${last ? "" : lucideSvg("chevron-right", 12, "text-zinc-600")}</span>`;
    })
    .join("");
  return `<nav aria-label="面包屑" class="flex flex-wrap items-center gap-1 text-xs text-zinc-500">${spans}</nav>`;
}

function defaultListPage(parts: ListParts): string {
  const cards = parts.items.map((p, i) => defaultPostCard(p, i)).join("");
  const pager = parts.showPager !== false ? defaultPager(parts.page, parts.totalPages, parts.hrefFor) : "";
  
  
  const isBlog = parts.variant === "blog";
  const isCategory = parts.variant === "category";
  const isSearch = parts.variant === "search";
  
  const isTerm = !isBlog && !isCategory && !isSearch;
  
  const backLink = isTerm || parts.variant === "category"
    ? `<div class="mb-6"><a href="/" class="text-sm text-zinc-400 hover:text-[var(--accent)]">← 首页</a>`
    : `<div class="mb-6"><a href="/" class="inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-[var(--accent)]">${lucideSvg("arrow-left", 14)}首页</a>`;
  const iconHtml = parts.titleIcon ? lucideSvg(parts.titleIcon, parts.variant === "search" ? 26 : 22, "text-[var(--accent)]") : "";
  const headHtml = isBlog
    ? defaultBreadcrumb([{ label: "首页", href: "/" }, { label: "文章" }]) +
      `<header class="mb-6 mt-3">` +
      `<h1 class="text-3xl font-bold text-zinc-100">${esc(parts.title)}</h1>` +
      (parts.sub ? `<p class="mt-1 text-sm text-zinc-500">${esc(parts.sub)}</p>` : "") +
      `</header>`
    : backLink +
      (isTerm
        ? `<h1 class="mt-2 text-3xl font-bold text-zinc-100">${esc(parts.title)}</h1>`
        : `<h1 class="mt-2 flex items-center gap-2 text-3xl font-bold text-zinc-100">${iconHtml}${esc(parts.title)}</h1>`) +
      (parts.titleDesc ? `<p class="mt-2 text-sm text-zinc-400">${esc(parts.titleDesc)}</p>` : parts.sub ? `<p class="mt-2 text-sm text-zinc-400">${esc(parts.sub)}</p>` : "") +
      `</div>`;
  const sidebar = parts.sidebarData
    ? defaultAside(parts.sidebarData.cats, parts.sidebarData.tags, parts.sidebarData.posts, parts.settings || {}, parts.sidebarData.showCatIcons === true)
    : "";
  
  
  const emptyText = isCategory
    ? "该分类下还没有文章。"
    : isSearch
      ? "没有匹配的文章。"
      : isTerm
        ? "该标签下还没有文章。"
        : "还没有已发布的文章。";
  const listHtml = cards
    ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">${cards}</div>`
    : isSearch && !(parts.query ?? "").trim()
      ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2"></div>`
      : `<p class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-zinc-400">${esc(emptyText)}</p>`;
  return `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><div>` +
    headHtml +
    (parts.extra || "") +
    listHtml +
    pager +
    `</div>${sidebar}</div>`;
}

function defaultShareButtons(title: string, url: string): string {
  const wb = `http://service.weibo.com/share/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`;
  const tw = `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`;
  const mail = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`;
  const btn = "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-zinc-300 transition hover:border-[var(--accent)] hover:text-[var(--accent)]";
  return `<div class="mt-8 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-6">` +
    `<span class="mr-1 inline-flex items-center gap-1 text-sm text-zinc-400">${lucideSvg("share-2", 15)}分享</span>` +
    `<button type="button" title="复制链接 / 系统分享" class="${btn}">${lucideSvg("link", 13)}复制链接</button>` +
    `<a href="${esc(wb)}" target="_blank" rel="noopener noreferrer" class="${btn}">微博</a>` +
    `<a href="${esc(tw)}" target="_blank" rel="noopener noreferrer" class="${btn}">Twitter</a>` +
    `<a href="${esc(mail)}" class="${btn}">${lucideSvg("mail", 13)}邮件</a>` +
    `</div>`;
}

function defaultRelatedSection(posts: PostView[]): string {
  if (!posts.length) return "";
  const cards = posts.map((p) =>
    `<a href="${esc(p.url)}" class="group rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--accent)]">` +
    `<h3 class="line-clamp-2 font-medium text-zinc-100 transition group-hover:text-[var(--accent)]">${esc(p.title)}</h3>` +
    (p.publishedAt ? `<p class="mt-2 text-xs text-zinc-500">${fmtDate(p.publishedAt)}</p>` : "") +
    `</a>`).join("");
  return `<section class="mt-10">` +
    `<h2 class="mb-4 flex items-center gap-2 text-lg font-bold text-zinc-100">${lucideSvg("folder-open", 18, "text-[var(--accent)]")}相关文章</h2>` +
    `<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">${cards}</div></section>`;
}

function defaultPostPage(parts: PostPageParts): string {
  const p = parts.post;
  const cats = (p.categories || []).map(defaultCatPill).join("");
  const author = esc(p.author?.name ?? "未知作者");
  const meta = parts.defMetaHtml || "";
  const tags = parts.defTagsHtml || "";
  const firstCat = (p.categories || [])[0];
  const crumb = defaultBreadcrumb([
    { label: "首页", href: "/" },
    { label: "文章", href: parts.blogIndex || "/blog" },
    ...(firstCat ? [{ label: firstCat.name, href: firstCat.url }] : []),
    { label: p.title },
  ]);
  return `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><article>` +
    `<header class="mb-6">` +
    `<a href="/" class="mb-4 inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--accent)]">${lucideSvg("arrow-left", 14)}返回首页</a>` +
    crumb +
    (cats ? `<div class="mb-3 mt-3 flex flex-wrap gap-2 text-xs">${cats}</div>` : "") +
    `<h1 class="text-3xl font-bold leading-tight text-[var(--text)]">${esc(p.title)}</h1>` +
    `<div class="mt-3 flex flex-wrap items-center gap-4 text-sm text-[var(--muted)]">` +
    `<span class="inline-flex items-center gap-1">${lucideSvg("user", 14)}${author}</span>` +
    `<span class="inline-flex items-center gap-1">${lucideSvg("calendar", 14)}${fmtDate(p.publishedAt)}</span>` +
    `<span class="inline-flex items-center gap-1">${lucideSvg("eye", 14)}${p.views} 阅读</span>` +
    (p.commentsCount > 0 ? `<span class="inline-flex items-center gap-1">${lucideSvg("message-circle", 14)}${p.commentsCount} 评论</span>` : "") +
    `</div>${meta}</header>` +
    (p.featuredImage ? `<img src="${esc(p.featuredImage)}" alt="${esc(p.title)}" class="mb-6 w-full rounded-2xl border border-[var(--border)] object-cover">` : "") +
    `<div class="prose-cms">${parts.bodyHtml}</div>` +
    (tags || "") +
    defaultShareButtons(p.title, parts.canonical || p.url) +
    defaultRelatedSection(parts.relatedTaxonomy || []) +
    (parts.postBottom || "") +
    parts.commentsHtml +
    `</article>` +
    `<div class="space-y-6">` +

    (parts.sidebarData
      ? defaultAside(parts.sidebarData.cats, parts.sidebarData.tags, parts.sidebarData.posts, parts.settings || {}, parts.sidebarData.showCatIcons === true)
      : "") +
    (parts.sidebarWidgets || "") +
    `</div></div>`;
}

function defaultPagePage(parts: PagePageParts): string {
  const p = parts.page;
  return `<div class="mx-auto max-w-3xl"><article>` +
    `<h1 class="text-3xl font-bold leading-tight text-[var(--text)]">${esc(p.title)}</h1>` +
    `<div class="prose-cms mt-8">${parts.bodyHtml}</div>` +
    `</article>${parts.commentsHtml}</div>`;
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

const pseudoBodyFix = `<style id="rv-body-fix">body, html { background: #0c0d1a !important; color: #f3f1ff !important; }</style>`;

function plYmd(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function plYmdDot(v: Date | string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ""
    : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
const plPad = (n: number, w = 3) => String(n).padStart(w, "0");

function pseudoNav(settings: Record<string, any>, items: MenuItem[]): string {
  const title = esc(settings.siteTitle ?? "");

  const list: MenuItem[] = items.length
    ? items
    : [{ id: "__index", label: "首页", url: "/" }, { id: "__archive", label: "全部文章", url: "/blog" }];
  const path = String(settings.__pathname ?? "/");
  const isActive = (url: string) => {
    if (!url) return false;
    if (url === "/") return path === "/";
    return path.startsWith(url);
  };
  const links = list
    .map((it) => `<li><a href="${esc(it.url)}"${it.target ? ` target="${esc(it.target)}"` : ""} data-active="${isActive(it.url) ? "true" : "false"}">${esc(it.label)}</a></li>`)
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

function pseudoPostCard(p: PostView, idx: number, total: number): string {
  const cover = (p as any).coverImage;
  const thumb = cover ? `<div class="pl-thumb" style="background-image:url(${esc(cover)})"></div>` : "";
  const cat = (p.categories || [])[0];
  const catHtml = cat
    ? `<span style="color:var(--pl-ink-3);opacity:0.5">·</span><span class="pl-cat">${esc(cat.name)}</span>`
    : "";
  return `<article class="pl-card">${thumb}` +
    `<div class="pl-card-meta"><span class="pl-num">N°${plPad(total - idx)}</span>` +
    `<span style="color:var(--pl-ink-3);opacity:0.5">·</span><span>${plYmd(p.publishedAt)}</span>${catHtml}</div>` +
    `<h3><a href="${esc(p.url)}">${esc(p.title)}</a></h3>` +
    (p.excerpt ? `<p>${esc(p.excerpt)}</p>` : "") +
    `<a href="${esc(p.url)}" class="pl-read">阅读全文</a>` +
    `</article>`;
}

function pseudoHomeCard(p: PostView, idx: number, total: number): string {
  const cover = (p as any).coverImage || p.featuredImage;
  const thumb = cover ? `<div class="pl-thumb" style="background-image:url(${esc(cover)})"></div>` : "";
  const cat = (p.categories || [])[0];
  const catHtml = cat
    ? `<span style="color:var(--pl-ink-3);opacity:0.5">·</span><span class="pl-cat">${esc(cat.name)}</span>`
    : "";
  return `<article class="pl-card">${thumb}` +
    `<div class="pl-card-meta"><span class="pl-num">N°${plPad(total - idx)}</span>` +
    `<span style="color:var(--pl-ink-3);opacity:0.5">·</span><span>${plYmd(p.publishedAt)}</span>${catHtml}</div>` +
    `<h3><a href="${esc(p.url)}">${esc(p.title)}</a></h3>` +
    (p.excerpt ? `<p>${esc(p.excerpt)}</p>` : "") +
    `<a href="${esc(p.url)}" class="pl-read">阅读全文</a>` +
    `</article>`;
}

function pseudoRenderTitle(raw: string): string {
  const words = raw.split(/(\s+)/);
  const targets = [/(log|press|signal|cyber|neon|code|byte|wire|glass|blog|写|笔记|记录)/i];
  const taken = new Set<number>();
  const pick = Math.min(2, Math.max(1, Math.floor(words.filter((w) => !/^\s+$/.test(w)).length / 3)));
  let found = 0;
  return words
    .map((w, i) => {
      if (taken.has(i)) return w;
      if (/^\s+$/.test(w)) return w;
      if (found < pick && targets.some((re) => re.test(w))) {
        taken.add(i);
        found++;
        return `<em>${esc(w)}</em>`;
      }
      return `<span>${esc(w)}</span>`;
    })
    .join("");
}

/** mirror ListPages.PageShell：mark + eyebrow + <small>title</small> + count。 */
function plSection(eyebrow: string, small: string, count: string, inner: string, style = ""): string {
  return `<section class="pl-section"${style ? ` style="${style}"` : ""}><div class="pl-section-head">` +
    `<h2><span class="pl-section-mark"></span>${eyebrow} <small>${small}</small></h2>` +
    (count ? `<span class="pl-count">${count}</span>` : "") +
    `</div>${inner}</section>`;
}

function plPager(page: number, totalPages: number, hrefFor: (p: number) => string): string {
  if (totalPages <= 1) return "";
  const nums: string[] = [];
  for (let i = 1; i <= totalPages; i++) {
    nums.push(i === page ? `<span class="pl-pager-current">${i}</span>` : `<a href="${esc(hrefFor(i))}">${i}</a>`);
  }
  return `<nav class="pl-pager">` +
    (page > 1 ? `<a href="${esc(hrefFor(page - 1))}"><span>←</span><span>prev</span></a>` : "") +
    nums.join("") +
    (page < totalPages ? `<a href="${esc(hrefFor(page + 1))}"><span>next</span><span>→</span></a>` : "") +
    `</nav>`;
}

function pseudoHome(parts: HomeParts): string {
  const settings = parts.settings as Record<string, any>;
  const ts = (parts.themeSettings ?? {}) as Record<string, any>;
  const items = [...parts.hero, ...parts.latest];
  const totalPublished = parts.total ?? items.length;
  const widgets = parts.widgets || "";
  const showHero = ts.showHero !== false;
  const heroEyebrow = String(ts.heroEyebrow || "Issue № 2026");
  const heroTitle = String(ts.heroTitle || settings.siteTitle);
  const heroSub = String(
    ts.heroSubtitle ||
      settings.tagline ||
      settings.siteDescription ||
      "A quiet log of things noticed, built and written down.",
  );
  const hero = showHero
    ? `<section class="pl-hero"><div class="pl-hero-card">` +
      `<div class="pl-hero-eyebrow"><span class="pl-pill-dot"></span>` +
      `<span>${esc(heroEyebrow)}</span><span style="opacity:0.5">·</span>` +
      `<span>${items.length} entries</span></div>` +
      `<h1 class="pl-title">${pseudoRenderTitle(heroTitle)}</h1>` +
      `<p class="pl-sub">${esc(heroSub)}</p>` +
      `<div class="pl-hero-actions">` +
      `<a href="/blog" class="pl-btn pl-btn-primary">探索文章<span class="pl-btn-arrow">→</span></a>` +
      `<a href="#index" class="pl-btn pl-btn-ghost">最近更新</a>` +
      `</div>` +
      `<div class="pl-hero-meta">` +
      `<div class="pl-stat">total entries<b>${plPad(totalPublished)}</b></div>` +
      `<div class="pl-stat">featured<b>${items[0] ? "N°" + plPad(items.length) : "—"}</b></div>` +
      `<div class="pl-stat">last update<b>${plYmd(items[0]?.publishedAt)}</b></div>` +
      `</div></div></section>`
    : "";
  const indexSection = `<section class="pl-section" id="index"><div class="pl-section-head">` +
    `<h2><span class="pl-section-mark"></span>最新发布 <small>recent entries</small></h2>` +
    `<span class="pl-count">count = ${items.length}</span></div>` +
    (items.length === 0
      ? `<div class="pl-empty">还没有文章。先去 admin 发布一篇吧。</div>`
      : `<div class="pl-grid">${items.map((p, i) => pseudoHomeCard(p, i, items.length)).join("")}</div>`) +
    (totalPublished > items.length
      ? `<div style="margin-top:36px;text-align:center"><a href="/blog" class="pl-btn pl-btn-ghost">查看更多文章<span class="pl-btn-arrow">→</span></a></div>`
      : "") +
    `</section>`;
  const widgetsSection = `<section class="pl-section" style="padding-top:0"><div class="pl-section-head">` +
    `<h2><span class="pl-section-mark"></span>侧栏 <small>widgets</small></h2></div>` +
    `<div class="pl-side-stack">${widgets}</div></section>`;
  return `<div>${hero}${indexSection}${widgetsSection}</div>`;
}

function pseudoListPage(parts: ListParts): string {
  const isBlog = parts.variant === "blog";
  const isCategory = parts.variant === "category";
  const isSearch = parts.variant === "search";
  const cards = parts.items.length
    ? `<div class="pl-grid">${parts.items.map((p, i) => pseudoPostCard(p, i, parts.items.length)).join("")}</div>`
    : `<div class="pl-empty">// 暂无内容 //</div>`;
  const pager = parts.showPager !== false ? plPager(parts.page, parts.totalPages, parts.hrefFor) : "";

  let eyebrow: string;
  let small: string;
  let count: string;
  let body: string;
  if (isBlog) {
    eyebrow = "全部文章";
    small = "archive";
    count = `page ${parts.page}/${parts.totalPages} · total = ${parts.total ?? parts.items.length}`;
    body = cards + pager;
  } else if (isCategory) {
    eyebrow = "分类";
    small = esc(parts.title);
    count = `${parts.items.length} entries`;
    body = cards;
  } else if (isSearch) {
    const cleaned = (parts.query ?? "").trim();
    eyebrow = "搜索";
    small = cleaned ? `"${esc(cleaned)}"` : "—";
    count = cleaned ? `${parts.items.length} results` : "—";
    body = cleaned ? cards : `<div class="pl-empty">// 在顶部搜索框输入关键词 //</div>`;
  } else {
    eyebrow = esc(parts.title);
    small = "";
    count = "";
    body = cards;
  }

  const widgetsSection = isBlog
    ? `<section class="pl-section" style="padding-top:0"><div class="pl-section-head">` +
      `<h2><span class="pl-section-mark"></span>侧栏 <small>widgets</small></h2></div>` +
      `<div class="pl-side-stack">${parts.widgets || ""}</div></section>`
    : "";
  return `<div>` +
    plSection(eyebrow, small, count, body) +
    widgetsSection +
    (parts.extra || "") +
    `</div>`;
}

function pseudoPostPage(parts: PostPageParts): string {
  const p = parts.post;
  const firstCat = (p.categories || [])[0];

  const headings: { id: string; text: string }[] = [];
  const bodyHtml = parts.bodyHtml.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_m, lv, attrs, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const id = `${p.slug}-h${headings.length}`;
    if (text) headings.push({ id, text });
    return `<h${lv} id="${id}">${inner}</h${lv}>`;
  });
  const tags = p.tags?.length
    ? `<div class="pl-tags">${p.tags.map((t) => `<a href="${esc(t.url || "#")}" class="pl-tag"># ${esc(t.name)}</a>`).join("")}</div>`
    : "";
  const toc = headings.length
    ? plSection("目录", "contents", `${headings.length} anchors`,
        `<ol class="pl-list">${headings.map((h, i) =>
          `<li class="pl-row" style="grid-template-columns:60px 1fr">` +
          `<span class="pl-num">N°${plPad(i + 1, 2)}</span>` +
          `<a href="#${h.id}" style="color:var(--pl-ink-2);font-size:14px;text-decoration:none">${esc(h.text)}</a></li>`).join("")}</ol>`,
        "padding-top:0;margin-top:48px")
    : "";
  const related = parts.related.length
    ? plSection("相关文章", "related entries", `count = ${parts.related.length}`,
        `<div class="pl-grid" style="grid-template-columns:repeat(auto-fill, minmax(220px, 1fr))">${parts.related.map((r, i) =>
          `<a href="${esc(r.url)}" class="pl-card" style="text-decoration:none;min-height:0">` +
          `<div class="pl-card-meta"><span class="pl-num">N°${plPad(i + 1, 2)}</span>` +
          `<span style="color:var(--pl-ink-3);opacity:0.5">·</span><span>${plYmdDot(r.publishedAt)}</span></div>` +
          `<h3 style="font-size:15">${esc(r.title)}</h3></a>`).join("")}</div>`,
        "padding-top:0;margin-top:32px")
    : "";
  const comments = `<section class="pl-section" style="padding-top:0;margin-top:32px"><div class="pl-section-head">` +
    `<h2><span class="pl-section-mark"></span>评论 <small>response · ${p.commentsCount} reply</small></h2></div>` +
    `${parts.commentsHtml}</section>`;
  return `<div class="pl-article-wrap"><div class="pl-article-card">` +
    `<a href="${esc(parts.blogIndex || "/blog")}" class="pl-back"><span>←</span><span>back to index</span></a>` +
    `<header class="pl-article-head">` +
    `<div class="pl-article-meta">` +
    (firstCat ? `<span class="pl-cat">§ ${esc(firstCat.name)}</span>` : `<span class="pl-cat">§ ARTICLE</span>`) +
    `<span>issue · <b class="pl-date">${plYmdDot(p.publishedAt)}</b></span>` +
    `<span><b>${p.views}</b> reads</span>` +
    `<span><b>${p.commentsCount}</b> reply</span>` +
    `</div>` +
    `<h1 class="pl-title">${esc(p.title)}</h1>` +
    (p.excerpt ? `<p class="pl-sub">${esc(p.excerpt)}</p>` : "") +
    `</header>` +
    (p.featuredImage
      ? `<div class="pl-cover" style="background-image:url(${esc(p.featuredImage)})" role="img" aria-label="${esc(p.title)}"></div>`
      : "") +
    `<div class="pl-content">${bodyHtml}</div>` +
    tags +
    toc +
    related +
    comments +
    `<aside style="margin-top:48px">${parts.widgets || ""}</aside>` +
    `</div></div>`;
}

function pseudoPagePage(parts: PagePageParts): string {
  const p = parts.page;
  const recent = parts.recent.length
    ? plSection("最新发布", "recent entries", `count = ${parts.recent.length}`,
        `<div class="pl-grid" style="grid-template-columns:repeat(auto-fill, minmax(220px, 1fr))">${parts.recent.map((r, i) =>
          `<a href="${esc(r.url)}" class="pl-card" style="text-decoration:none;min-height:0">` +
          `<div class="pl-card-meta"><span class="pl-num">N°${plPad(i + 1, 2)}</span>` +
          `<span style="color:var(--pl-ink-3);opacity:0.5">·</span><span>${plYmdDot(r.publishedAt)}</span></div>` +
          `<h3 style="font-size:15">${esc(r.title)}</h3></a>`).join("")}</div>`,
        "padding-top:0;margin-top:48px")
    : "";
  const comments = p.commentStatus === "open"
    ? `<section class="pl-section" style="padding-top:0;margin-top:32px"><div class="pl-section-head">` +
      `<h2><span class="pl-section-mark"></span>评论 <small>response</small></h2></div>` +
      `${parts.commentsHtml}</section>`
    : "";
  return `<div class="pl-article-wrap"><div class="pl-article-card">` +
    `<a href="/" class="pl-back"><span>←</span><span>back home</span></a>` +
    `<header class="pl-article-head">` +
    `<div class="pl-article-meta">` +
    `<span class="pl-cat">§ PAGE</span>` +
    (p.publishedAt ? `<span>issue · <b class="pl-date">${plYmdDot(p.publishedAt)}</b></span>` : "") +
    `<span><b>${p.views}</b> reads</span>` +
    `</div>` +
    `<h1 class="pl-title">${esc(p.title)}</h1>` +
    (p.excerpt ? `<p class="pl-sub">${esc(p.excerpt)}</p>` : "") +
    `</header>` +
    (p.featuredImage
      ? `<div class="pl-cover" style="background-image:url(${esc(p.featuredImage)})" role="img" aria-label="${esc(p.title)}"></div>`
      : "") +
    `<div class="pl-content">${parts.bodyHtml}</div>` +
    recent +
    comments +
    `<aside style="margin-top:48px">${parts.widgets || ""}</aside>` +
    `</div></div>`;
}

const pseudolinearChrome: ThemeChrome = {
  slug: "pseudolinear",
  cssHref: () => themeCssHref("pseudolinear"),
  bodyFix: () => pseudoBodyFix,
  headExtra: () => "",
  nav: (settings, items) => pseudoNav(settings, items),
  
  
  
  bodyOpen: (settings, items) =>
    `<div class="th-pseudo">` + pseudoNav(settings, items) + `<main id="sk-main"><div class="pl-frame">`,
  bodyClose: (settings, footerHtml) =>
    `</div></main>${footerHtml}</div>`,
  aside: () => "",
  footer: (settings) => pseudoFooter(settings),
  home: pseudoHome,
  listPage: pseudoListPage,
  postPage: pseudoPostPage,
  pagePage: pseudoPagePage,
};

const cmBodyFix = `<style id="rv-body-fix">body,html{background:#050a06 !important;color:#9bff7a !important}</style>`;

function cmDate(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}
const cmPad = (n: number, w = 3) => String(n).padStart(w, "0");

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

function cmSection(eyebrow: string, small: string, count: string, inner: string): string {
  return `<section class="cm-section"><div class="cm-section-head">` +
    `<h2>${esc(eyebrow)} <small>${small}</small></h2>` +
    (count ? `<span class="cm-count">${count}</span>` : "") +
    `</div>${inner}</section>`;
}

function cmPostCard(p: PostView, idx: number, total: number): string {
  const cat = (p.categories || [])[0];
  const catHtml = cat ? `<span>·</span><span class="cm-cat">${esc(cat.name)}</span>` : "";
  const slug = String(p.slug || p.url || "").replace(/^\/+|\/+$/g, "").split("/").pop() || "";
  return `<article class="cm-card">` +
    `<div class="cm-card-meta"><span class="cm-num">N°${cmPad(total - idx, 2)}</span><span>·</span><span>${cmDate(p.publishedAt)}</span>${catHtml}</div>` +
    `<h3><a href="${esc(p.url)}">${esc(p.title)}</a></h3>` +
    (p.excerpt ? `<p>${esc(p.excerpt)}</p>` : "") +
    `<a href="${esc(p.url)}" class="cm-read">cat ${esc(slug)}</a>` +
    `</article>`;
}

function cmPostRow(p: PostView, idx: number, total: number): string {
  return `<div class="cm-row">` +
    `<span class="cm-num">N°${cmPad(total - idx, 2)}</span>` +
    `<h3><a href="${esc(p.url)}">${esc(p.title)}</a></h3>` +
    `<span class="cm-date">${cmDate(p.publishedAt)}</span></div>`;
}

function cmCardsHtml(items: PostView[]): string {
  if (!items.length) return `<div class="cm-empty">// no entries</div>`;
  return `<div class="cm-grid">${items.map((p, i) => cmPostCard(p, i, items.length)).join("")}</div>`;
}

function cmRowsHtml(items: PostView[]): string {
  if (!items.length) return `<div class="cm-empty">// no entries</div>`;
  return `<div class="cm-list">${items.map((p, i) => cmPostRow(p, i, items.length)).join("")}</div>`;
}

function cmPager(page: number, totalPages: number, hrefFor: (p: number) => string): string {
  if (totalPages <= 1) return "";
  const nums: string[] = [];
  for (let i = 1; i <= totalPages; i++) {
    nums.push(i === page ? `<span class="cm-pager-current">${i}</span>` : `<a href="${esc(hrefFor(i))}">${i}</a>`);
  }
  return `<nav class="cm-pager">` +
    (page > 1 ? `<a href="${esc(hrefFor(page - 1))}"><span>&lt;</span><span>prev</span></a>` : "") +
    nums.join("") +
    (page < totalPages ? `<a href="${esc(hrefFor(page + 1))}"><span>next</span><span>&gt;</span></a>` : "") +
    `</nav>`;
}

function cmWidgets(widgetsHtml: string, withSmall = true): string {
  const h2 = withSmall
    ? `<h2>widgets <small>// optional modules</small></h2>`
    : `<h2>widgets</h2>`;
  return `<section class="cm-section"><div class="cm-section-head">${h2}</div>` +
    `<div class="cm-side">${widgetsHtml}</div></section>`;
}

function cmMiniCard(p: PostView, idx: number, total: number): string {
  return `<a href="${esc(p.url)}" class="cm-card" style="min-height:0">` +
    `<div class="cm-card-meta"><span class="cm-num">N°${cmPad(total - idx, 2)}</span>` +
    `<span>·</span><span>${cmDate(p.publishedAt)}</span></div>` +
    `<h3 style="font-size:15">${esc(p.title)}</h3></a>`;
}

function cmHome(parts: HomeParts): string {
  const settings = parts.settings as Record<string, any>;
  const all = [...parts.hero, ...parts.latest];
  const total = parts.total ?? all.length;
  const cats = parts.cats || [];
  const widgets = parts.widgets || "";
  const year = new Date().getFullYear();
  const blogIndex = parts.blogIndex || "/blog";
  const tagline = settings.tagline || settings.siteDescription || "a quiet log of things noticed, built and written down.";
  const sub = settings.siteDescription || "Running a small TTY session of the web. Type a command, read a post, exit cleanly.";
  const hero = `<section class="cm-hero">` +
    `<pre class="cm-boot">[ OK ]  codeman-os v1.0.0 .............. loaded
[ OK ]  tty1 ........................... online
[ OK ]  mount /var/log/articles ........ ${cmPad(total, 4)} entries
[ OK ]  network ......................... ${esc(String(settings.siteTitle ?? ""))}
[ OK ]  uptime ........................ ${year}-Q${Math.ceil((new Date().getMonth() + 1) / 3)}</pre>` +
    `<div class="cm-prompt-line"><span>cat</span><b>${esc(String(settings.siteTitle ?? ""))}.log</b><span>| less</span></div>` +
    `<h1 class="cm-title">// <b>${esc(String(settings.siteTitle ?? ""))}</b><br />${esc(String(tagline))}</h1>` +
    `<p class="cm-sub">${esc(String(sub))}</p>` +
    `<div class="cm-actions">` +
    `<a href="${esc(blogIndex)}" class="cm-btn cm-btn-primary"><span>$</span> ls ./posts --all</a>` +
    `<a href="${esc(blogIndex)}?sort=recent" class="cm-btn cm-btn-ghost"><span>$</span> tail -f ./recent.log</a>` +
    `</div>` +
    `<div class="cm-meta">` +
    `<div>entries<b>${cmPad(total, 3)}</b></div>` +
    `<div>categories<b>${cmPad(cats.length, 3)}</b></div>` +
    `<div>uptime<b>${year - 2020}+y</b></div>` +
    `</div></section>`;
  
  
  const recentItems = all.slice(0, 9);
  const recent = cmSection("recent log", `// last ${recentItems.length} writes`, "$ ls -lt ./posts | head -9", cmCardsHtml(recentItems));
  const catSection = cats.length
    ? cmSection("categories", "// dirs under /blog", `$ ls /blog | wc -l = ${cats.length}`,
        `<div class="cm-grid">${cats.slice(0, 6).map((c) =>
          `<a href="${esc(c.url)}" class="cm-card" style="min-height:0"><div class="cm-card-meta">` +
          `<span class="cm-num">DIR</span><span>·</span><span>${(c as any).postCount ?? 0} files</span></div>` +
          `<h3 style="font-size:15">./${esc(c.slug)}/</h3></a>`).join("")}</div>`)
    : "";
  return `<div>${hero}${recent}${catSection}${cmWidgets(widgets)}</div>`;
}

function cmListPage(parts: ListParts): string {
  const isBlog = parts.variant === "blog";
  const isCategory = parts.variant === "category";
  const isSearch = parts.variant === "search";
  const pager = parts.showPager !== false ? cmPager(parts.page, parts.totalPages, parts.hrefFor) : "";
  
  let small: string;
  let count: string;
  let body: string;
  if (isBlog) {
    small = `// archive, page ${parts.page}/${parts.totalPages}`;
    count = `total = ${parts.total ?? parts.items.length}`;
    body = cmRowsHtml(parts.items) + pager;
  } else if (isCategory) {
    small = `/${esc(parts.title)}`;
    count = `${parts.items.length} files`;
    body = cmCardsHtml(parts.items);
  } else if (isSearch) {
    const cleaned = (parts.query ?? "").trim();
    small = cleaned ? `"${esc(cleaned)}"` : "—";
    count = cleaned ? `${parts.items.length} matches` : "—";
    body = cleaned ? cmCardsHtml(parts.items) : `<div class="cm-empty">// type a query in the top bar</div>`;
  } else {
    small = `/${esc(parts.title)}`;
    count = "";
    body = cmCardsHtml(parts.items);
  }
  const eyebrow = isBlog ? "$ ls /blog" : isCategory ? "$ cd /blog" : "$ grep -ri";

  return `<div>` +
    cmSection(eyebrow, small, count, body) +
    (isBlog ? cmWidgets(parts.widgets || "", false) : "") +
    (parts.extra || "") +
    `</div>`;
}

function cmPostPage(parts: PostPageParts): string {
  const p = parts.post;
  const blogIndex = parts.blogIndex || "/blog";
  const cat = (p.categories || [])[0];
  const catTag = cat ? `[${esc(cat.name)}]` : "[ARTICLE]";

  const headings: { id: string; text: string }[] = [];
  const bodyHtml = parts.bodyHtml.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_m, lv, attrs, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const id = `${p.slug}-h${headings.length}`;
    if (text) headings.push({ id, text });
    return `<h${lv} id="${id}">${inner}</h${lv}>`;
  });
  const toc = headings.length
    ? cmSection("table of contents", `// ${headings.length} anchors`, "",
        `<div class="cm-list">${headings.map((h, i) =>
          `<div class="cm-row" style="grid-template-columns:60px 1fr">` +
          `<span class="cm-num">N°${cmPad(i + 1, 2)}</span>` +
          `<a href="#${h.id}" style="color:var(--cm-ink-2);font-size:13px;text-decoration:none">${esc(h.text)}</a></div>`).join("")}</div>`)
    : "";
  const related = parts.related.length
    ? cmSection("related", "// other reads", `count = ${parts.related.length}`,
        `<div class="cm-grid">${parts.related.map((r, i) =>
          `<a href="${esc(r.url)}" class="cm-card" style="min-height:0"><div class="cm-card-meta">` +
          `<span class="cm-num">N°${cmPad(parts.related.length - i, 2)}</span><span>·</span><span>${cmDate(r.publishedAt)}</span></div>` +
          `<h3 style="font-size:15">${esc(r.title)}</h3></a>`).join("")}</div>`)
    : "";
  const tags = p.tags?.length
    ? `<div class="cm-tags">${p.tags.map((t) => `<a href="${esc(t.url || "#")}" class="cm-tag">${esc(t.name)}</a>`).join("")}</div>`
    : "";
  return `<article class="cm-article">` +
    `<a href="${esc(blogIndex)}" class="cm-back">cd ..</a>` +
    `<div class="cm-article-meta">` +
    `<span class="cm-cat">${catTag}</span>` +
    `<span>date = <b>${cmDate(p.publishedAt)}</b></span>` +
    `<span>views = <b>${p.views}</b></span>` +
    `<span>replies = <b>${p.commentsCount}</b></span>` +
    `</div>` +
    `<h1 class="cm-title">${esc(p.title)}</h1>` +
    (p.excerpt ? `<p class="cm-sub">${esc(p.excerpt)}</p>` : "") +
    (p.featuredImage
      ? `<div class="cm-cover" style="background-image:url(${esc(p.featuredImage)})" role="img" aria-label="${esc(p.title)}"></div>`
      : "") +
    `<div class="cm-content">${bodyHtml}</div>` +
    tags +
    toc +
    related +
    cmSection("log replies", `// ${p.commentsCount} response(s)`, "", parts.commentsHtml) +
    cmWidgets(parts.widgets || "", false) +
    `</article>`;
}

function cmPagePage(parts: PagePageParts): string {
  const p = parts.page;
  const meta = `<div class="cm-article-meta">` +
    `<span class="cm-cat">[PAGE]</span>` +
    (p.publishedAt ? `<span>date = <b>${cmDate(p.publishedAt)}</b></span>` : "") +
    `<span>views = <b>${p.views}</b></span>` +
    `</div>`;
  const recent = parts.recent.length
    ? cmSection("recent", `// last ${parts.recent.length} writes`, "",
        `<div class="cm-grid">${parts.recent.map((r, i) => cmMiniCard(r, i, parts.recent.length)).join("")}</div>`)
    : "";
  const comments = p.commentStatus === "open"
    ? `<section class="cm-section"><div class="cm-section-head"><h2>log replies</h2></div>${parts.commentsHtml}</section>`
    : "";
  return `<article class="cm-article">` +
    `<a href="/" class="cm-back">cd ..</a>` +
    meta +
    `<h1 class="cm-title">${esc(p.title)}</h1>` +
    (p.excerpt ? `<p class="cm-sub">${esc(p.excerpt)}</p>` : "") +
    (p.featuredImage
      ? `<div class="cm-cover" style="background-image:url(${esc(p.featuredImage)})" role="img" aria-label="${esc(p.title)}"></div>`
      : "") +
    `<div class="cm-content">${parts.bodyHtml}</div>` +
    recent +
    comments +
    cmWidgets(parts.widgets || "", false) +
    `</article>`;
}

const codemanChrome: ThemeChrome = {
  slug: "codeman",
  cssHref: () => themeCssHref("codeman"),
  bodyFix: () => cmBodyFix,
  headExtra: () => "",
  nav: (settings, items) => cmNav(settings, items),

  bodyOpen: (settings, items) =>
    `<div class="cm-crt">` + cmNav(settings, items) +
    `<main id="sk-main"><div class="cm-window"><div class="cm-window-inner"><div class="cm-frame">`,
  bodyClose: (settings, footerHtml) =>
    `</div></div></div></main>${footerHtml}</div>`,
  aside: () => "",
  footer: (settings) => cmFooter(settings),
  home: cmHome,
  listPage: cmListPage,
  postPage: cmPostPage,
  pagePage: cmPagePage,
};

function bmixNavActive(settings: Record<string, any>, url: string): boolean {
  let path = String(settings.__pathname ?? "/");
  const base = String(settings.__basePath ?? "").replace(/\/+$/, "");
  if (base && path.indexOf(base) === 0) path = path.slice(base.length) || "/";
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+$/, "") || "/";
  let href = String(url || "/").trim();
  if (!href) return false;

  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return false;
  if (!href.startsWith("/")) href = "/" + href;
  const q = href.indexOf("?");
  if (q >= 0) href = href.slice(0, q);
  href = href.replace(/\/+$/, "") || "/";
  if (href === "/") return path === "/";
  return path === href || path.indexOf(href + "/") === 0;
}

function bmixNav(settings: Record<string, any>, items: MenuItem[]): string {
  const title = esc(settings.siteTitle ?? "");
  const logo = settings.logoUrl
    ? `<img src="${esc(settings.logoUrl)}" alt="${title}">`
    : `<span>${title}</span>`;

  const activeIdx = items.findIndex(
    (it) => bmixNavActive(settings, it.url) || (it.children || []).some((c) => bmixNavActive(settings, c.url)),
  );
  const lis = items
    .map((it, i) => {
      const ic = bmixIconFile(it.icon, 12);
      const kids = it.children?.length
        ? `<span class="bm-caret" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>` +
          `<ul class="bm-submenu">${(it.children || [])
            .map(
              (c) => {
                const cAct = bmixNavActive(settings, c.url);
                return `<li${cAct ? ' class="is-active"' : ""}><a href="${esc(c.url)}" target="${c.target === "_blank" ? "_blank" : "_self"}"${c.target === "_blank" ? ' rel="noopener noreferrer"' : ""}${cAct ? ' aria-current="page"' : ""}>${bmixIconFile(c.icon, 12) ? `<span class="bm-nav-icon">${bmixIconFile(c.icon, 12)}</span>` : ""}${esc(c.label)}</a></li>`;
              },
            )
            .join("")}</ul>`
        : "";
      const active = i === activeIdx;
      const cls = [kids ? "bm-has-sub" : "", active ? "is-active" : ""].filter(Boolean).join(" ");
      return `<li data-nav-index="${i}"${cls ? ` class="${cls}"` : ""}>` +
        `<a href="${esc(it.url)}" target="${it.target === "_blank" ? "_blank" : "_self"}"${it.target === "_blank" ? ' rel="noopener noreferrer"' : ""} class="bm-nav-link"${active ? ' aria-current="page"' : ""}>${ic ? `<span class="bm-nav-icon">${ic}</span>` : ""}${esc(it.label)}</a>${kids}</li>`;
    })
    .join("");
  const onHome = String(settings.__pathname ?? "/").replace(/\/+$/, "") === "" || String(settings.__pathname ?? "/") === "/";
  const logoCls = onHome ? "logo flex items-center router-link-active router-link-exact-active" : "logo flex items-center";
  return `<div class="nav-top">` +
    `<div class="nav at-top" data-rv-navbar>` +
    `<div class="nav-content container-np flex items-center xxs:flex-wrap xs:flex-wrap">` +
    `<button type="button" class="mobile-menu-btn sm:hidden md:hidden lg:hidden xl:hidden flex flex-col justify-center" aria-label="菜单" aria-expanded="false" data-rv-menu-btn><div></div><div></div><div></div></button>` +
    `<a href="/" class="${logoCls}"${onHome ? ' aria-current="page"' : ""}>${logo}</a>` +
    `<button type="button" class="mobile-sidebar-btn md:hidden lg:hidden xl:hidden" aria-label="个人信息" aria-expanded="false" style="margin-left:auto" data-rv-sidebar-btn><div class="sidebar-icon flex justify-end"><div class="sidebar-icon-sidebar"><div></div><div></div><div></div></div></div></button>` +
    `<div class="menu flex-grow xxs:order-last xs:order-last flex justify-end xxs:justify-start xs:justify-start" data-rv-menunav>` +
    `<div class="pf_scroller flex" data-rv-scroller>` +
    `<ul class="menu" data-level="0">` +
    `<li class="anchor${activeIdx === 0 ? " anchor-first" : ""}" aria-hidden="true" data-rv-anchor style="transform:translateX(0px);width:0;opacity:0;left:0"></li>` +
    lis +
    `</ul></div></div>` +
    `<div class="menu-funcs flex items-center">` +
    `<span class="self-center">` +
    `<button type="button" class="theme-toggle cursor-hand" aria-label="切换到深色模式" title="切换到深色" data-rv-theme-toggle>` +
      `<span class="theme-toggle-ic">${bmixIc("moon", 15)}</span>` +
    `</button>` +
    `</span>` +
    `<span class="self-center">` +
      `<div class="sf-search"><button type="button" class="nav-search cursor-hand" aria-label="搜索" aria-expanded="false">${bmixIc("search", 16)}</button></div>` +
    `</span>` +
    `</div>` +
    `</div></div></div>`;
}

function bmixFooter(settings: Record<string, any>, widgetsHtml: string): string {
  const year = new Date().getFullYear();
  const copyright = settings.footerText || `Designed &amp; Coded by oboext © ${year} ${settings.siteTitle}`;
  
  const links: any[] = Array.isArray(settings.footerLinks) ? settings.footerLinks : [];
  const linkCls = 'class="flex gx-3 items-center text-embossed hover:text-primary-gray"';
  const linksHtml = links.length
    ? links
        .map(
          (l: any) =>
            `<a ${linkCls} href="${esc(l.url || "#")}" target="_blank" rel="noopener noreferrer">${l.image ? `<img src="${esc(l.image)}" alt="">` : ""}<span>${String(l.text ?? "")}</span></a>`,
        )
        .join("")
    : settings.icpNumber
      ? `<a ${linkCls} href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer"><span>${esc(settings.icpNumber as string)}</span></a>`
      : "";
  return `<footer class="py-16 text-xs relative">` +
    (widgetsHtml ? `<div class="container-np px-10">${widgetsHtml}</div>` : "") +
    `<div class="container-np px-10" style="margin-inline:auto">` +
    `<div class="text-right text-primary-gray text-bulge-primary-gray">${copyright}</div>` +
    
    `<div class="mt-4 flex flex-wrap gx-8 gy-3 justify-end">${linksHtml}</div>` +
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

const BMIX_CARD_THEME_META_KEY = "bluemix_card_theme";

function bmixNormalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let h = v.replace(/\s+/g, "");
  if (!h) return null;
  if (h[0] !== "#") h = "#" + h;
  if (/^#[0-9a-fA-F]{3}$/.test(h)) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
  return h.toLowerCase();
}

/** mirror cardTheme.ts themeColorFromMeta。 */
function bmixThemeColorFromMeta(value: unknown): string | null {
  return typeof value === "string" ? bmixNormalizeHex(value) : null;
}

/** Deterministic per-card glass tone (mirror of cardVars.cardTone + color.toneFromColor). */
function bmixCardTone(
  seed: string,
  fallbackIndex: number,
  bgAlpha = 1,
  metas?: Record<string, string> | null,
): { vars: Record<string, string>; dark: boolean } {
  
  
  const preset = bmixThemeColorFromMeta(metas ? metas[BMIX_CARD_THEME_META_KEY] : null);
  const base = preset ?? BMIX_PALETTE[_hash(seed || String(fallbackIndex)) % BMIX_PALETTE.length];
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

function bmixYmd(v: Date | string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const BMIX_ICON_ALIAS: Record<string, string> = {
  comments: "message-square-text",
  "bars-staggered": "layout-list",
  more: "ellipsis",
  "ranking-star": "award",
  "right-to-bracket": "log-in",
  "caret-down": "chevron-down",
  "house-user": "house",
};
function bmixIconName(name: string): string {
  return BMIX_ICON_ALIAS[name] || name;
}

function bmixIc(icon: string, size: number, marginRight = 0): string {
  const px = Math.round(size * 1.35);
  const mr = marginRight ? `margin-right:${marginRight}px` : "";
  
  
  const fromFile = lucideSvg(bmixIconName(icon), px, "", mr);
  if (fromFile) return fromFile;
  const common = `width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-0.125em;flex-shrink:0;${mr}"`;
  if (icon === "sun") {
    return `<svg ${common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
  }
  if (icon === "moon") {
    return `<svg ${common}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>`;
  }
  const paths: Record<string, string> = {
    search: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35",
    bookmark: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
    heart: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
    comments: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
    eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z",
    clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-16v6l4 2",
    "bars-staggered": "M2 6h20M2 12h14M2 18h20",
    "chevron-left": "m15 18-6-6 6-6",
    "chevron-right": "m9 18 6-6-6-6",
    lightbulb: "M9 18h6M10 22h4M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
    "pen-line": "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
    book: "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20",
    "ranking-star": "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  };
  const circle = icon === "eye" ? `<circle cx="12" cy="12" r="3"/>` : "";
  return `<svg ${common}>${circle}<path d="${paths[icon] || paths.bookmark}"/></svg>`;
}

const iconFileCache = new Map<string, string | null>();

const LUCIDE_CLASS_ALIAS: Record<string, string> = { "share-2": "share2" };

function lucideSvg(name: string, px: number, cls = "", styleExtra = ""): string {
  let svg = iconFileCache.get(name);
  if (svg === undefined) {
    try { svg = fs.readFileSync(path.join(process.cwd(), "oboext/public/icons", `${name}.svg`), "utf8"); }
    catch { svg = null; }
    iconFileCache.set(name, svg);
  }
  if (!svg) return "";
  const c = cls ? ` ${cls}` : "";
  const style = `display:inline-block;vertical-align:-0.125em;flex-shrink:0${styleExtra ? ";" + styleExtra : ""}`;
  
  
  
  
  return svg
    .replace(/\s(?:width|height)="\d+"/g, "")
    .replace(/^<svg\b[^>]*?\bxmlns="[^"]*"/, (m) => `${m} width="${px}" height="${px}"`)
    .replace(/stroke="#[0-9a-fA-F]{3,8}"/, 'stroke="currentColor"')
    .replace(/class="lucide lucide-[^"]*"/, `class="lucide lucide-${LUCIDE_CLASS_ALIAS[name] || name}${c}"`)
    .replace(/(<svg\b[^>]*)>/, `$1 style="${style}">`);
}

function bmixIconFile(name: string | null | undefined, size: number, cls = ""): string {
  if (!name) return "";
  const key = String(name).trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) return "";
  return lucideSvg(key, Math.round(size * 1.35), cls);
}

function bmixPostCard(p: PostView, idx: number): string {
  const t = bmixCardTone(p.slug || p.url, idx, 1, p.metas);
  
  const preset = bmixThemeColorFromMeta(p.metas?.[BMIX_CARD_THEME_META_KEY]) ? ' data-bmx-preset="1"' : "";
  const darkCls = t.dark ? " is-dark" : "";
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(";");
  const { title1, title2 } = bmixSplitTitle(p.title);
  const img = p.featuredImage
    ? `background-image:url('${p.featuredImage.replace(/'/g, "%27")}')`
    : "background-image:linear-gradient(135deg,#dce8f7,#c9ddf5 60%,#bcd6f3)";
  const tags = (p.tags || []).slice(0, 3).map((tg) => tg.name).join(" · ") || "&nbsp;";
  return `<article class="post-card"><div class="post-card-wrapper${darkCls}" style="transform:perspective(720px) scale3d(1,1,1);${vars}">` +
    `<a href="${esc(p.url)}" aria-label="${esc(p.title)}" class="card card-container${darkCls}"${preset}>` +
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
  const show = {
    first: page > 3,
    prev2: page >= 3,
    prev1: page >= 2,
    next1: page <= total - 1,
    next2: page <= total - 2,
    last: page <= total - 3,
  };
  const cells: string[] = [];
  if (show.first) cells.push(`<li class="first" data-tip="第一页"><a href="${esc(hrefFor(1))}"><span>1</span>${bmixIc("chevrons-left", 12)}</a></li>`);
  if (show.prev2) cells.push(`<li><a href="${esc(hrefFor(page - 2))}">${page - 2}</a></li>`);
  if (show.prev1) cells.push(`<li><a href="${esc(hrefFor(page - 1))}">${page - 1}</a></li>`);
  cells.push(`<li class="active"><a aria-current="page">${page}</a></li>`);
  if (show.next1) cells.push(`<li><a href="${esc(hrefFor(page + 1))}">${page + 1}</a></li>`);
  if (show.next2) cells.push(`<li><a href="${esc(hrefFor(page + 2))}">${page + 2}</a></li>`);
  if (show.last) cells.push(`<li class="last" data-tip="最后一页"><a href="${esc(hrefFor(total))}">${bmixIc("chevrons-right", 12)}<span>${total}</span></a></li>`);
  return `<div class="main-pagination-wrapper"><ul class="main-pagination">` +
    
    `<li class="anchor" aria-hidden style="transform:translateX(0px);width:0px;transition-duration:0s"></li>` +
    cells.join("") + `</ul></div>`;
}

function bmixHeroScene(p: PostView, i: number): string {
  const { title1, title2 } = bmixSplitTitle(p.title);
  
  const t = bmixCardTone(p.slug || p.url, i, 0.8, p.metas);
  const preset = bmixThemeColorFromMeta(p.metas?.[BMIX_CARD_THEME_META_KEY]) ? ' data-bmx-preset="1"' : "";
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(";");
  const darkCls = t.dark ? " is-dark" : "";
  const role = i === 0 ? "current" : i === 1 ? "future-0" : i === 2 ? "future-1" : i === 3 ? "past-0" : "past-1";
  const img = p.featuredImage
    ? `<img class="bg" src="${esc(p.featuredImage)}" alt="${esc(title1)}" loading="eager">`
    : "";
  const meta = `<div class="metas"><span>${bmixIc("heart", 12)} ${p.likes ?? 0}</span>` +
    `<span class="ml-8">${bmixIc("comments", 12)} ${p.commentsCount ?? 0}</span>` +
    `<span class="ml-8">${bmixIc("eye", 12)} ${p.views ?? 0}</span>` +
    
    (p.publishedAt ? `<span class="ml-8">${bmixIc("clock", 12)} ${bmixYmd(p.publishedAt)}</span>` : "") +
    `</div>`;
  return `<div class="scene ${role}"><a href="${esc(p.url)}" class="card-container${darkCls}" style="${vars}" aria-label="${esc(p.title)}"${preset}>` +
    `<div class="bg-wrapper">${img}</div>` +
    `<div class="card-wrapper"><div class="card flex"><div class="info flex flex-col justify-center">` +
    `<div class="main-title ${title2 ? "type-2" : "type-1 truncate"}"><span class="block truncate">${esc(title1)}</span>` +
    (title2 ? `<span class="block truncate">${esc(title2)}</span>` : "") +
    `</div>${meta}</div>` +
    (p.featuredImage ? `<img src="${esc(p.featuredImage)}" alt="">` : "") +
    `</div></div></a></div>`;
}

function bmixBanner(posts: PostView[], max: number): string {
  const visible = (posts || []).slice(0, Math.max(1, Math.min(max, 5)));
  if (!visible.length) return `<div class="coverflow-swiper"><div class="slider"><div class="stage"></div></div></div>`;
  const scenes = visible.map((p, i) => bmixHeroScene(p, i)).join("");
  const dots = visible.length > 1
    ? `<div class="anchors-wrapper"><div class="anchors">${visible
        .map((_, i) => `<button type="button" class="anchor${i === 0 ? " active" : ""}" aria-label="第 ${i + 1} 张"></button>`)
        .join("")}</div></div>`
    : "";
  const controls = visible.length > 1
    ? `<div class="controls"><button type="button" class="prev" aria-label="上一个">${bmixIc("chevron-left", 16)}</button><button type="button" class="next" aria-label="下一个">${bmixIc("chevron-right", 16)}</button></div>`
    : "";
  return `<div class="coverflow-swiper"><div class="slider"><div class="stage">${scenes}</div>${controls}${dots}</div></div>`;
}

function bmixCatNav(activeHref: string, cats: TaxRef[], blogIndex: string): string {
  
  
  const isActive = (href: string) => {
    if (!activeHref) return false;
    if (href === activeHref) return true;
    if (href === "/" || href === blogIndex) return false;
    return activeHref.startsWith(href);
  };
  const parentIds = new Set(cats.filter((c) => (c as any).parentId != null).map((c) => (c as any).parentId));
  const roots = cats.filter((c) => (c as any).parentId == null || !parentIds.has((c as any).parentId));
  const items: string[] = [];
  items.push(`<li data-ai="0" class="${isActive("/") ? "is-active" : ""}"><a href="/" target="_self" aria-current="${isActive("/") ? "page" : ""}">${bmixIc("lightbulb", 13, 6)}智能推荐</a></li>`);
  items.push(`<li data-ai="1" class="${isActive(blogIndex) ? "is-active" : ""}"><a href="${esc(blogIndex)}" target="_self" aria-current="${isActive(blogIndex) ? "page" : ""}">${bmixIc("pen-line", 13, 6)}最新文章</a></li>`);
  let ai = 2;
  
  for (const root of roots) {
    const children = cats.filter((c) => (c as any).parentId === (root as any).id);
    if (children.length) {
      const sub = children
        .map((c) => `<li class="${isActive(c.url) ? "is-active" : ""}"><a href="${esc(c.url)}" target="_self" aria-current="${isActive(c.url) ? "page" : ""}">${c.icon ? bmixIconFile(c.icon, 11) : bmixIc("bookmark", 11, 6)}${esc(c.name)}</a></li>`)
        .join("");
      items.push(`<li data-ai="${ai++}" class="has-submenu${isActive(root.url) || children.some((c) => isActive(c.url)) ? " is-active" : ""}"><span class="pill-toggle" role="link" aria-expanded="false">${root.icon ? bmixIconFile(root.icon, 13) : bmixIc("book", 13, 6)}${esc(root.name)}${lucideSvg("chevron-down", 10, "caret")}</span><ul class="submenu" data-level="1">${sub}</ul></li>`);
    } else {
      items.push(`<li data-ai="${ai++}" class="${isActive(root.url) ? "is-active" : ""}"><a href="${esc(root.url)}" target="_self" aria-current="${isActive(root.url) ? "page" : ""}">${root.icon ? bmixIconFile(root.icon, 13) : bmixIc("bookmark", 13, 6)}${esc(root.name)}</a></li>`);
    }
  }
  return `<div class="nav-cat"><div class="pf_scroller flex"><ul class="menu" data-level="0">` +
    `<li class="anchor" aria-hidden="true" style="transform:translateX(0px);width:0px;opacity:0"></li>` +
    items.join("") +
    `</ul></div></div>`;
}

function bmRankIcon(key: string): string {
  return key === "most_likes" ? "heart" : key === "most_reads" ? "eye" : "comments";
}

function bmRankPane(
  boards: any,
  key: string,
  labels: Record<string, string>,
  GOLD: string,
  SILVER: string,
  BRONZE: string,
): string {
  const board = (boards as any)[key] || [];
  const first = board[0];
  const rest = board.slice(1, 3);
  const icon = bmRankIcon(key);
  const firstCard = first
    ? `<div class="place-wrapper"><a href="${esc(first.url)}" class="first-place active"><span class="thumbnail-wrapper"><img class="crown absolute" src="/theme-assets/bluemix/rankings/8113d099.png" srcset="/theme-assets/bluemix/rankings/8113d099.png 2x, /theme-assets/bluemix/rankings/23841780.png 3x" alt="">${first.thumbnail ? `<img class="thumbnail r-full" src="${esc(first.thumbnail)}" alt="">` : `<span class="thumbnail r-full rk-noimg"></span>`}</span><span class="first-info"><span class="main-title">${esc(bmixStripTag(first.title))}</span><span class="metas"><span>${bmixIc("heart", 11)} ${first.likes}</span><span>${bmixIc("comments", 11)} ${first.comments}</span><span>${bmixIc("eye", 11)} ${first.views}</span></span></span><img class="place place-gold" src="${esc(GOLD)}" alt=""></a></div>`
    : "";
  const others = rest
    .map((p: RankPost, g: number) => `<div class="place-wrapper"><a href="${esc(p.url)}" class="other-place"><img class="place" src="${esc(g === 0 ? SILVER : BRONZE)}" alt=""><span class="other-title">${esc(bmixStripTag(p.title))}</span><span class="other-meta">${bmixIc(icon, 11)} ${key === "most_likes" ? p.likes : key === "most_reads" ? p.views : p.comments}</span></a></div>`)
    .join("");
  return `<div class="rankings">${firstCard}${others}</div>`;
}

function bmixStripTag(title: string): string {
  return String(title ?? "").replace(/\[[^\]]+\]/, "");
}

function bmixRankings(
  boards: { most_comments: RankPost[]; most_likes: RankPost[]; most_reads: RankPost[] } | null | undefined,
  tabs: { labels: Record<string, string>; order: string[]; defaultTab: string } | undefined,
): string {
  if (!boards) return "";
  const empty = boards.most_comments.length === 0 && boards.most_likes.length === 0 && boards.most_reads.length === 0;
  if (empty) return "";
  const order = tabs?.order && tabs.order.length === 3 ? tabs.order : ["most_comments", "most_likes", "most_reads"];
  const labels = tabs?.labels || {};
  const DEF: Record<string, string> = { most_comments: "热评文章", most_likes: "大家喜欢", most_reads: "阅读最多" };
  const defaultTab = tabs?.defaultTab && order.includes(tabs.defaultTab) ? tabs.defaultTab : order[0];
  const GOLD = "/theme-assets/bluemix/rankings/873a161a.svg";
  const SILVER = "/theme-assets/bluemix/rankings/b31ba85e.svg";
  const BRONZE = "/theme-assets/bluemix/rankings/661ec968.svg";
  
  const tabsHtml = order
    .map((k) => `<div class="tab${k === defaultTab ? " active" : ""}" data-tab="${k}">${bmixIc(bmRankIcon(k), 14)}${esc(labels[k] || DEF[k] || k)}</div>`)
    .join("");
  
  const bgSrc = (boards as any)[defaultTab]?.[0]?.thumbnail || "";
  const bgLayer = bgSrc
    ? `<div class="bg-layer absolute inset-0"><div class="bg absolute inset-0"><img class="full absolute" src="${esc(bgSrc)}" alt=""><img class="thumbnail absolute bottom-0 right-0" src="${esc(bgSrc)}" alt=""></div></div>`
    : `<div class="bg-layer absolute inset-0"></div>`;
  const tabIndex = order.indexOf(defaultTab);
  
  const boardsJson = JSON.stringify(boards).replace(/</g, "\\u003c");
  return `<div class="widget-rankings mb-20" data-boards="${esc(boardsJson)}" data-default-tab="${esc(defaultTab)}"><div class="cat-title flex items-center extra-large justify-center"><div class="custom-icon mr-5">${bmixIc("ranking-star", 15)}</div><div class="content text-primary-gray text-bulge-primary-gray">排行榜</div></div>` +
    `<div class="rankings-wrapper relative">` + bgLayer +
    `<div class="rankings-tabs"><div class="rankings-tab-row"><div class="tab-anchor" style="transform:translate(${tabIndex * 100}%)"></div>${tabsHtml}</div></div>` +
    `<div class="card-container">${bmRankPane(boards, defaultTab, labels, GOLD, SILVER, BRONZE)}</div></div></div>`;
}

function bmixHomeArticleRow(p: PostView): string {
  const img = p.featuredImage
    ? `background-image:${cssUrl(p.featuredImage)}`
    : "background-image:linear-gradient(135deg,#dce8f7,#bcd6f3)";
  return `<div class="article mb-10 flex items-center g-8"><a href="${esc(p.url)}" class="thumbnail flex-shrink-0" style="${img}"></a>` +
    `<span class="info"><a href="${esc(p.url)}" class="title block">${esc(p.title)}</a>` +
    `<span class="metas flex gx-5 mt-1"><span class="text-error">${bmixIc("heart", 10)} ${p.likes ?? 0}</span>` +
    `<span class="text-primary">${bmixIc("comments", 10)} ${p.commentsCount ?? 0}</span>` +
    `<span class="text-success">${bmixIc("eye", 10)} ${p.views ?? 0}</span></span></span></div>`;
}

function bmixHomeSidebar(posts: PostView[], settings: Record<string, unknown>, ts: Record<string, unknown>): string {
  const items = posts || [];
  const popular = [...items].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 4);
  const recent = items.filter((p) => !popular.some((q) => q.id === p.id)).slice(0, 4);
  const avatarRaw =
    (typeof (ts as any)?.sidebarAvatarImage === "string" && (ts as any).sidebarAvatarImage.trim()) ||
    (settings.logoUrl as string) ||
    (items[0]?.featuredImage as string) ||
    "linear-gradient(135deg,#7ba3e0,#b59df0)";
  const isGradient = avatarRaw.startsWith("linear-gradient");
  const avatarStyle = isGradient ? `background-image:${avatarRaw}` : `background-image:${cssUrl(avatarRaw)}`;
  const avatarNode = `<div class="avatar" style="${avatarStyle}"></div>`;
  const bloggerDesc = String(settings.tagline ?? settings.siteDescription ?? "Design a colorful life");
  return `<div class="panel"><div class="wrapper"><aside class="bmx-blocks">` +
    `<div class="widget-blogger flex items-center g-8">${avatarNode}<div class="metas"><div class="name">${esc(String(settings.siteTitle ?? ""))}</div><div class="description text-embossed">${esc(bloggerDesc)}</div></div></div>` +
    `<div class="widget-title"><div class="title">热门文章</div></div><div class="widget-articles mb-20">${popular.map(bmixHomeArticleRow).join("")}</div>` +
    `<div class="widget-title"><div class="title">最新文章</div></div><div class="widget-articles mb-20">${(recent.length ? recent : items.slice(0, 4)).map(bmixHomeArticleRow).join("")}</div>` +
    `</aside></div></div>`;
}

function bmixSection(title: string, to: string, icon: string | null, posts: PostView[]): string {
  const cards = posts.map((p, i) => bmixPostCard(p, i)).join("");
  
  
  const titleHtml = `<div class="cat-title flex items-center large">` +
    (icon ? `<div class="custom-icon mr-5">${bmixIconFile(icon, 15)}</div>` : `<div class="icon flex default mr-5 ml-2"></div>`) +
    `<div class="content text-primary-gray text-bulge-primary-gray">${esc(title)}</div>` +
    `<div class="line flex-grow ml-8 flex items-center"><span class="line-track"></span>` +
    `<a href="${esc(to)}" class="more-btn flex items-center justify-center text-sm r-full text-embossed truncate"><span class="flex items-center justify-center"><span class="more-text">更多</span>${bmixIc("chevron-right", 7)}</span></a></div></div>`;
  return `<section class="home-category">${titleHtml}<div class="home-category-articles">${cards}</div></section>`;
}

function bmixHome(parts: HomeParts): string {
  const ts = parts.themeSettings || {};
  const showHero = parts.showHero !== false;
  const bannerMax = parts.bannerMax || 5;
  const recentCount = parts.recentCount || 8;
  const recent = parts.recent && parts.recent.length ? parts.recent : [...parts.hero, ...parts.latest];
  const inner = recent.length === 0
    ? `<p class="text-primary-gray" style="padding:24px">还没有已发布的文章。去后台发布一篇，或先导入示例内容吧。</p>`
    : `<div class="bmx-reveal"><div class="recent-articles">${recent.slice(0, recentCount).map((p, i) => bmixPostCard(p, i)).join("")}</div></div>`;
  
  const catTitle = `<div class="cat-title flex items-center large"><div class="icon flex default mr-5 ml-2"></div><div class="content text-primary-gray text-bulge-primary-gray">近期文章</div>` +
    `<div class="line flex-grow ml-8 flex items-center"><span class="line-track"></span>` +
    `<a href="${esc(parts.blogIndex || "/blog")}" class="more-btn flex items-center justify-center text-sm r-full text-embossed truncate"><span class="flex items-center justify-center"><span class="more-text">更多</span>${bmixIc("chevron-right", 7)}</span></a></div></div>`;
  const mainContent = `${catTitle}${inner}`;
  const sidebar = bmixHomeSidebar(recent, parts.settings, ts as Record<string, unknown>);
  const catNav = bmixCatNav("/", parts.cats, parts.blogIndex || "/blog");
  const banner = showHero ? bmixBanner(recent, bannerMax) : "";
  const rankings = bmixRankings(parts.rankings, parts.rankTabs);
  const sections = (parts.sections || []).map((s) => `<div class="bmx-reveal">${bmixSection(s.row.title, s.row.category.url, s.row.icon, s.posts)}</div>`).join("");
  return `<div class="home">` +
    banner +
    `<div class="content-wrapper flex container-np line reverse">` +
    `<div class="sidebar"><div class="pf_scroller sidebar-sticky"><div class="sidebar-content">${sidebar}</div></div></div>` +
    `<div class="main-content">${catNav}${mainContent}</div>` +
    `</div>` +
    rankings +
    sections +
    `</div>`;
}

function bmixListPage(parts: ListParts): string {
  const isBlog = parts.variant === "blog";
  const isCategory = parts.variant === "category";
  const isSearch = parts.variant === "search";
  const blogIndex = parts.blogIndex || "/blog";
  
  const catNav = isSearch ? "" : bmixCatNav(parts.activeHref || (isBlog ? blogIndex : "/"), parts.cats || [], blogIndex);

  
  const hero = (parts.hero || []).filter((p) => p && p.url);
  const showBanner = !isSearch && hero.length > 0;
  const banner = showBanner ? bmixBanner(hero, parts.bannerMax || 5) : "";

  
  
  const contentInner = isCategory
    ? `<span class="inline-flex items-center gap-2">${parts.titleIcon ? bmixIconFile(parts.titleIcon, 15) : ""}${esc(parts.title)}${parts.titleDesc ? ` · ${esc(parts.titleDesc)}` : ""}</span>`
    : esc(parts.title);
  const catTitle =
    `<div class="cat-title flex items-center large">` +
    `<div class="icon flex default mr-5 ml-2"></div>` +
    `<div class="content text-primary-gray text-bulge-primary-gray">${contentInner}</div>` +
    `<div class="line flex-grow ml-8 flex items-center"><span class="line-track"></span></div></div>`;

  
  
  const gridCls = isBlog ? "blog-grid" : isSearch ? "recent-articles" : "list-grid";
  const cards = parts.items.map((p, i) => bmixPostCard(p, i)).join("");
  
  const pager = !isCategory && parts.showPager !== false ? bmixPager(parts.page, parts.totalPages, parts.hrefFor) : "";
  
  const emptyHtml = `<p class="text-primary-gray" style="padding:24px">${esc(
    parts.emptyHint || (isCategory ? "该分类下还没有文章。" : isSearch ? "没有匹配的文章。" : "还没有已发布的文章。"),
  )}</p>`;
  const body = cards
    ? 
      isCategory
      ? `<div class="${gridCls}">${cards}</div>${pager}`
      : `<div class="list-switch-anim"><div class="${gridCls}">${cards}</div>${pager}</div>`
    : emptyHtml;
  
  const contentCls = showBanner ? "list-content" : "list-content list-content--gapped";
  
  const drawer = parts.drawerPosts && parts.drawerPosts.length
    ? `<div class="sidebar list-drawer-sidebar"><div class="pf_scroller sidebar-sticky"><div class="sidebar-content">${bmixHomeSidebar(parts.drawerPosts, parts.settings || {}, parts.themeSettings || {})}</div></div></div>`
    : "";
  return `<div class="${isCategory ? "term" : "list"}">` +
    banner +
    `<div class="${contentCls}">` +
    catNav +
    catTitle +
    body +
    `</div>` +
    drawer +
    `</div>`;
}

/** Inject stable h2/h3 ids so the side TOC anchors match them; captures the
 *  heading list in the same pass. */
function bmixHeadings(html: string, slug: string): { html: string; toc: { id: string; text: string; level: number }[] } {
  const toc: { id: string; text: string; level: number }[] = [];
  let i = 0;
  const out = html.replace(/<h([23])[^>]*>(.*?)<\/h\1>/gi, (m, lv, inner) => {
    const id = `${slug}-h${i++}`;
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (text) toc.push({ id, text, level: Number(lv) });
    return `<h${lv} id="${id}">${inner}</h${lv}>`;
  });
  return { html: out, toc };
}

/** One thumbnail+title+heart/comment/view row, same markup as the theme widgets. */
function bmixSideRow(p: PostView): string {
  const img = p.featuredImage
    ? `background-image:${cssUrl(p.featuredImage)}`
    : "background-image:linear-gradient(135deg,#dce8f7,#bcd6f3)";
  return `<div class="article mb-10 flex items-center g-8">` +
    `<a href="${esc(p.url)}" class="thumbnail flex-shrink-0" style="${img}"></a>` +
    `<span class="info"><a href="${esc(p.url)}" class="title block">${esc(p.title)}</a>` +
    `<span class="metas flex gx-5 mt-1">` +
    `<span class="text-error">${bmixIc("heart", 10)} ${p.likes ?? 0}</span>` +
    `<span class="text-primary">${bmixIc("comments", 10)} ${p.commentsCount ?? 0}</span>` +
    `<span class="text-success">${bmixIc("eye", 10)} ${p.views ?? 0}</span>` +
    `</span></span></div>`;
}

function bmixArticleGroup(title: string, posts: PostView[], emptyText?: string): string {
  const empty = posts.length === 0 && emptyText
    ? `<div class="article mb-10 flex items-center g-8"><span class="info"><span class="title block text-primary-gray">${esc(emptyText)}</span></span></div>`
    : "";
  return `<div class="widget-title"><div class="title">${esc(title)}</div></div>` +
    `<div class="widget-articles mb-20">${empty}${posts.map(bmixSideRow).join("")}</div>`;
}

function bmixPostToc(toc: { id: string; text: string; level: number }[]): string {
  if (!toc.length) return "";
  const lis = toc.map((h) =>
    `<li data-toc-type="${h.level === 2 ? "H2" : "H3"}">` +
    `<a class="toc_wrapper" href="#${h.id}" data-bmx-toc-link="${h.id}"><span>${esc(h.text)}</span></a></li>`).join("");
  return `<div class="widget-toc mb-10"><ul>${lis}</ul></div>`;
}

/** Sidebar article-section tabs: bookmark (TOC + related) by default, bars
 *  switches to popular/random. Both panes render server-side; theme-bluemix.js
 *  toggles visibility with a light slide-in animation. */

function bmixCommentHead(count: number): string {
  return `<div class="cat-title flex items-center large"><div class="custom-icon mr-5">${bmixIc("comments", 14)}</div>` +
    `<div class="content text-primary-gray text-bulge-primary-gray">${count} 条回应</div>` +
    `<div class="line flex-grow ml-8 flex items-center justify-end"></div></div>`;
}

function bmixPostSidebar(toc: { id: string; text: string; level: number }[], post: PostView, related: PostView[], popular: PostView[], randomPool: PostView[]): string {
  const busy = new Set([...related.map((p) => p.id), ...popular.map((p) => p.id)]);
  const random: PostView[] = [];
  for (const p of randomPool) { if (random.length >= 4) break; if (!busy.has(p.id)) random.push(p); }
  for (const p of randomPool) { if (random.length >= 4) break; if (!random.some((r) => r.id === p.id)) random.push(p); }
  
  
  const paneBookmark = bmixPostToc(toc) + bmixArticleGroup("相关文章", related, "暂无其它文章");
  const paneBars = bmixArticleGroup("大家喜欢", popular, "暂无其它文章") + bmixArticleGroup("随机文章", random, "暂无其它文章");
  const paneJson = JSON.stringify({ bookmark: paneBookmark, bars: paneBars }).replace(/</g, "\\u003c");
  return `<div class="sidebar-titles"><ul class="grid cols-2">` +
    `<li class="anchor" aria-hidden="true" style="transform:translateX(100%)"></li>` +
    `<li class="title" data-bmx-tab="bars"><a href="#" aria-label="大家喜欢" role="link" data-role="tab">${bmixIc("bars-staggered", 12, 0)}</a></li>` +
    `<li class="title active" data-bmx-tab="bookmark"><a href="#" aria-label="目录·相关" role="link" data-role="tab">${bmixIc("bookmark", 12, 0)}</a></li>` +
    `</ul></div>` +
    `<div class="panel"><div class="wrapper">` +
    `<aside class="bmx-blocks bmx-tab-stage" data-bmx-panes="${esc(paneJson)}" data-bmx-shown="bookmark">` +
    `<div class="bmx-tab-pane" data-bmx-pane="bookmark">${paneBookmark}</div>` +
    `</aside></div></div>`;
}

/** bluemix article page — coverflow hero + two-column (sidebar / main). */
function bmixPostPage(parts: PostPageParts): string {
  const p = parts.post;
  const { html: bodyHtml, toc } = bmixHeadings(parts.bodyHtml, p.slug || "post");
  const { title1, title2 } = bmixSplitTitle(p.title);
  const t = bmixCardTone(p.slug || p.url, 0, 0.8, p.metas);
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(";");
  const darkCls = t.dark ? " is-dark" : "";
  const hasImage = !!p.featuredImage;
  const imgUrl = hasImage ? esc(p.featuredImage!) : "";
  const date = fmtDate(p.publishedAt);
  const badges = [];
  const bg = p.featuredImage
    ? `<div class="bg-wrapper"><img class="bg" src="${imgUrl}" alt="${esc(p.title)}" loading="eager"></div>`
    : `<div class="bg-wrapper"></div>`;
  const presetAttr = bmixThemeColorFromMeta(p.metas?.[BMIX_CARD_THEME_META_KEY]) ? ' data-bmix-preset="1"' : "";
  const heroCard = `<div class="card-container${darkCls} bg-blur" data-bmix-hero${presetAttr} style="${vars}">` +
    bg +
    `<div class="card-wrapper"><div class="card flex">` +
    `<div class="info flex flex-col justify-center">` +
    `<div class="main-title ${title2 ? "type-2" : "type-1 truncate"}">` +
    `<span class="block truncate">${esc(title1)}</span>` +
    (title2 ? `<span class="block truncate">${esc(title2)}</span>` : "") +
    `</div>` +
    `<div class="metas">` +
    `<span>${bmixIc("heart", 12)} ${p.likes ?? 0}</span>` +
    `<span class="ml-8">${bmixIc("comments", 12)} ${p.commentsCount ?? 0}</span>` +
    `<span class="ml-8">${bmixIc("eye", 12)} ${p.views ?? 0}</span>` +
    (date ? `<span class="ml-8">${bmixIc("clock", 12)} ${date}</span>` : "") +
    (badges.length ? badges.map((b) => `<span class="ml-8">${bmixIc("clock", 12)} ${esc(b)}</span>`).join("") : "") +
    `</div></div>` +
    (hasImage ? `<img src="${imgUrl}" alt="" >` : "") +
    `</div></div></div>`;
  const sidebar = bmixPostSidebar(toc, p, parts.related || [], parts.popular || [], parts.random || []);
  
  
  
  return `<div class="single"><div data-post-type="article">` +
    `<div class="coverflow-swiper"><div class="container-np"><div class="slider mx-10">` +
    heroCard +
    `</div></div></div>` +
    `<div class="content-wrapper flex container-np line reverse">` +
    `<div class="sidebar"><div class="pf_scroller sidebar-sticky"><div class="sidebar-content">${sidebar}</div></div></div>` +
    `<div class="main-content">` +
    `<div class="model-wrapper article"><div class="model">` +
    `<article class="bmx-blocks" data-bmix-article>${bodyHtml}</article>` +
    parts.shareHtml +
    `</div></div>` +
    (parts.commentsHtml
      ? `<div class="model-wrapper"><div class="model">` +
        bmixCommentHead(p.commentsCount) +
        parts.commentsHtml +
        `</div></div>`
      : "") +
    `</div></div></div></div>`;
}

function bmixPageSideRow(p: PostView): string {
  const img = p.featuredImage
    ? `background-image:${cssUrl(p.featuredImage)}`
    : "background-image:linear-gradient(135deg,#dce8f7,#bcd6f3)";
  return `<div class="article mb-10 flex items-center g-8">` +
    `<a href="${esc(p.url)}" class="thumbnail flex-shrink-0" style="${img}"></a>` +
    `<span class="info"><a href="${esc(p.url)}" class="title block">${esc(p.title)}</a>` +
    `<span class="metas flex gx-5 mt-1">` +
    `<span class="text-primary">${bmixIc("comments", 10)} ${p.commentsCount ?? 0}</span>` +
    `<span class="text-success">${bmixIc("eye", 10)} ${p.views ?? 0}</span>` +
    `</span></span></div>`;
}

function bmixPagePage(parts: PagePageParts): string {
  const p = parts.page;
  const { title1, title2 } = bmixSplitTitle(p.title);
  const t = bmixCardTone(p.slug || p.url, 2, 0.8);
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(";");
  const darkCls = t.dark ? " is-dark" : "";
  const hasImage = !!p.featuredImage;
  const imgUrl = hasImage ? esc(p.featuredImage!) : "";
  
  const viewsInMeta = p.metas?.["bluemix_page_meta_views"] === "1";
  const metas = viewsInMeta
    ? `<div class="metas">` +
      `<span>${bmixIc("heart", 12)} 0</span>` +
      `<span class="ml-8">${bmixIc("comments", 12)} ${p.commentsCount ?? 0}</span>` +
      `<span class="ml-8">${bmixIc("eye", 12)} ${p.views ?? 0}</span>` +
      `</div>`
    : "";
  const heroCard = `<div class="card-container${darkCls} bg-blur" style="${vars}">` +
    (hasImage
      ? `<div class="bg-wrapper"><img class="bg" src="${imgUrl}" alt="${esc(title1)}" loading="eager"></div>`
      : `<div class="bg-wrapper"></div>`) +
    `<div class="card-wrapper"><div class="card flex">` +
    `<div class="info flex flex-col justify-center">` +
    `<div class="main-title ${title2 ? "type-2" : "type-1 truncate"}">` +
    `<span class="block truncate">${esc(title1)}</span>` +
    (title2 ? `<span class="block truncate">${esc(title2)}</span>` : "") +
    `</div>${metas}</div>` +
    (hasImage ? `<img src="${imgUrl}" alt="">` : "") +
    `</div></div></div>`;
  const recentRows = parts.recent.map(bmixPageSideRow).join("");
  const sidebar = `<div class="panel"><div class="wrapper"><aside class="bmx-blocks">` +
    `<div class="widget-title"><div class="title">最新文章</div></div>` +
    `<div class="widget-articles mb-20">` +
    (parts.recent.length === 0
      ? `<div class="article mb-10 flex items-center g-8"><span class="info"><span class="title block text-primary-gray">暂无文章</span></span></div>`
      : recentRows) +
    `</div></aside></div></div>`;
  const postview = !viewsInMeta
    ? `<div class="single-postview text-right" style="display:flex;gap:16px;justify-content:flex-end;margin:4px 6px 26px;font-size:13px;color:var(--text-color-3)">` +
      `<span class="meta">${bmixIc("eye", 13, 4)} ${p.views ?? 0} 阅读</span>` +
      `<span class="meta">${bmixIc("comments", 13, 4)} ${p.commentsCount ?? 0} 回应</span>` +
      `</div>`
    : "";
  const comments = p.commentStatus === "open" && parts.commentsHtml
    ? `<div class="model-wrapper"><div class="model">` +
      `<div class="cat-title flex items-center large"><div class="content text-primary-gray text-bulge-primary-gray">回应</div></div>` +
      parts.commentsHtml +
      `</div></div>`
    : "";
  return `<div class="single"><div data-post-type="page">` +
    `<div class="coverflow-swiper" style="margin-bottom:8px"><div class="container-np"><div class="slider mx-10">` +
    heroCard +
    `</div></div></div>` +
    `<div class="content-wrapper flex container-np line reverse">` +
    `<div class="sidebar"><div class="pf_scroller sidebar-sticky"><div class="sidebar-content">${sidebar}</div></div></div>` +
    `<div class="main-content">` +
    `<div class="model-wrapper page"><div class="model"><article class="bmx-blocks">${parts.bodyHtml}</article></div></div>` +
    postview +
    comments +
    `</div></div></div></div>`;
}

export function bluemixNotFoundPage(parts: {
  settings: { title: string; message: string; showSearch: boolean; showRecent: boolean };
  recent: { url: string; title: string }[];
}): string {
  const { settings, recent } = parts;
  const lines = String(settings.message || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const msg = lines.length
    ? `<div class="bmx-404-msg">${lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>`
    : "";
  const search = settings.showSearch
    ? `<form class="bmx-404-search" role="search" action="/search" method="get">` +
      `<input type="search" name="q" placeholder="搜索文章…" aria-label="搜索文章">` +
      `<button type="submit">${lucideSvg("search", 15)}搜索</button></form>`
    : "";
  const recentHtml = recent.length
    ? `<div class="bmx-404-recent"><h2 class="bmx-404-recent-title">最近文章</h2><ul>` +
      recent.map((p) => `<li><a href="${esc(p.url)}">${esc(p.title)}</a></li>`).join("") +
      `</ul></div>`
    : "";
  return `<div class="bmx-404"><div class="model-wrapper"><div class="model bmx-404-card">` +
    `<div class="bmx-404-num" aria-hidden="true">404</div>` +
    `<h1 class="bmx-404-title">${esc(settings.title)}</h1>` +
    msg +
    `<div class="bmx-404-actions"><a href="/" class="bmx-404-home">` +
    `<span class="bmx-404-home-icon">${lucideSvg("arrow-left", 15)}</span>` +
    `<span class="bmx-404-home-text">带我回家</span></a></div>` +
    search +
    recentHtml +
    `</div></div></div>`;
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
  
  bodyFix: () => `<style id="rv-body-fix">body{background:#e5e9ef!important;color:var(--text-color-2)!important}html{background:#e5e9ef!important}</style>`,
  headExtra: () => `<style id="rv-theme-bluemix-vars">${BLUEMIX_VARS}</style>`,
  nav: (settings, items) => bmixNav(settings, items),
  bodyOpen: (settings, items) =>
    
    
    `<div class="th-bluemix">` +
    `<svg width="0" height="0" aria-hidden="true" style="position:absolute"><defs><linearGradient id="bmx-cat-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="20%" class="bmx-g-s" stop-color="#33bbff"></stop><stop offset="80%" class="bmx-g-e" stop-color="#1f8bff"></stop>` +
    `</linearGradient></defs></svg>` +
    bmixNav(settings, items) +
    `<main id="sk-main"><div class="pf-route-frame pf-init" data-bmx-frame>`,
  
  bodyClose: (settings, footerHtml) =>
    `</div></main>` +
    `<div class="full-loading show" aria-hidden="true"><div class="lines"><div></div><div></div><div></div><div></div><div></div></div></div>` +
    `<noscript><style>.full-loading{display:none!important}.pf-route-frame{opacity:1!important;transform:none!important}</style></noscript>` +
    footerHtml + `</div>`,
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
