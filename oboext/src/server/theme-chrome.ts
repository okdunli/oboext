// Theme-aware chrome rendering.
import fs from "fs";
import path from "path";
import type { PostView, TaxRef } from "./queries.js";
import type { PageView } from "./pages.js";
import * as R from "./render.js";
import { esc, fmtDate } from "./render.js";
import { mimeFor, PUBLIC_DIR } from "./storage.js";

// -------------------------------------------------------------------- types

export interface ThemeChrome {
  slug: string;
  cssHref(): string;
  // The full stylesheet, inlined into `<head>` as a `<style>` block.
  cssInline?(): string;
  // Raw CSS that must apply as early as possible (the theme's base background/colour, before the external stylesheet lands).
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
  // bluemix full-home extras (ignored by the other themes)
  recent?: PostView[];
  sections?: { row: { category: TaxRef; title: string; icon: string | null }; posts: PostView[] }[];
  rankings?: { most_comments: RankPost[]; most_likes: RankPost[]; most_reads: RankPost[] } | null;
  rankTabs?: { labels: Record<string, string>; order: string[]; defaultTab: string };
  themeSettings?: Record<string, unknown>;
  blogIndex?: string;
  showHero?: boolean;
  bannerMax?: number;
  recentCount?: number;

  /** bluemix `home-top` widget area, rendered under the banner. */
  homeTop?: string;

  /** bluemix home sidebar widget area (inside aside.bmx-blocks). */
  sideWidgets?: string;
  /** Published posts per category id, for the sidebar list (default theme). */
  catCounts?: Map<number, number>;
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

  sidebarData?: { posts: PostView[]; tags: TaxRef[]; cats: TaxRef[]; showCatIcons?: boolean; catCounts?: Map<number, number> };

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

  /** post.meta filter values for the bluemix hero badge row (original
   *  parity: PostPage.tsx meta={{ ..., badges: metaItems.map(m => m.value) }}). */
  metaBadges?: string[];

  /** The full post.meta items (label + value) — themes whose post page is
   *  R.postPage render them on the meta line via the pluginMeta param. */
  metaItems?: R.MetaItem[];

  defMetaHtml?: string;
  tagsHtml: string;

  defTagsHtml?: string;
  shareHtml: string;

  blogIndex?: string;

  widgets?: string;

  postBottom?: string;

  sidebarWidgets?: string;

  canonical?: string;

  sidebarData?: { posts: PostView[]; tags: TaxRef[]; cats: TaxRef[]; showCatIcons?: boolean; catCounts?: Map<number, number> };

  settings?: Record<string, unknown>;
};

export type PagePageParts = {
  page: PageView;
  bodyHtml: string;
  recent: PostView[];
  commentsHtml: string;

  widgets?: string;
};

// ------------------------------------------------------------------- helpers

const THEMES_DIR = path.join(process.cwd(), "themes");

let cssCache = new Map<string, { css: string; mtime: number }>();

function readThemeCss(slug: string, file: string): { css: string; mtime: number } {
  const key = slug + ":" + file;
  const cached = cssCache.get(key);
  try {
    const fp = path.join(THEMES_DIR, slug, file);
    const st = fs.statSync(fp);
    // mtime changed (dev edit / theme upload): drop the stale entry so the
    // ?v= version query picks the new bytes instead of serving the old CSS.
    if (cached && cached.mtime === st.mtimeMs) return cached;
    const css = fs.readFileSync(fp, "utf-8");
    const entry = { css, mtime: st.mtimeMs };
    cssCache.set(key, entry);
    return entry;
  } catch {
    return { css: "", mtime: 0 };
  }
}

// T5: preload a theme's declared fonts (manifest.json "fonts": [...]) so the browser fetches them alongside the stylesheet instead of after it .
function fontPreloadLinks(slug: string): string {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, slug, "manifest.json"), "utf-8")) as { fonts?: string[] };
    return (m.fonts ?? [])
      .map((f) => `<link rel="preload" as="font" type="font/woff2" href="/theme-assets/${slug}/${f}" crossorigin>`)
      .join("");
  } catch {
    return "";
  }
}

function themeCssHref(slug: string): string {
  // Skyscraper's stylesheet is the build-time generated /public/theme.css (tools/gen.mjs inlines its fonts), so it never rides /theme-style/<slug>.
  if (slug === "skyscraper") return publicAssetHref("theme.css");
  const main = readThemeCss(slug, slug + ".css");
  let v = String(Math.round(main.mtime));
  try {
    const extra = readThemeCss(slug, slug + "-extra.css");
    if (extra.mtime) v += "-" + String(Math.round(extra.mtime));
  } catch { /* no extra */ }
  return `/theme-style/${slug}?v=${v}`;
}

/**
 * Version stamp for /public/<file>. Served with an `immutable` year-long cache,
 * so the stamp must change with the bytes or returning visitors keep the old
 * build. Vercel freezes file mtimes to a fixed epoch, so an mtime stamp is
 * constant across deploys — we stamp a content hash instead. Cache keyed by
 * byte size so the file is only re-read when its length changes.
 */
const assetVersionCache = new Map<string, { size: number; v: string }>();
function fnv1a32(buf: Buffer): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export function publicAssetHref(file: string): string {
  try {
    const fp = path.join(PUBLIC_DIR, file);
    const st = fs.statSync(fp);
    const cached = assetVersionCache.get(file);
    if (cached && cached.size === st.size) return `/public/${file}?v=${cached.v}`;
    const v = fnv1a32(fs.readFileSync(fp));
    assetVersionCache.set(file, { size: st.size, v });
    return `/public/${file}?v=${v}`;
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
// =========================================================================== Built-in comment form — shared structural baseline Markup.
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
// The toolbar: emoji trigger on the left, actions on the right, one row.
.comment-form .sf-toolbar{
  display:flex; align-items:center; justify-content:space-between;
  gap:12px; margin-top:8px;
}
.comment-form .funcs{ display:flex; position:relative; }
.comment-form .sf-toolbar .form-actions{
  display:flex; justify-content:flex-end; align-items:center; gap:8px;
  margin-top:0;
}
// Below the two-column breakpoint the row still holds - the emoji button is 36px and the submit is intrinsic - but the gap has to shrink or the pair.
@media (max-width:420px){
  .comment-form .sf-toolbar{ gap:8px; }
}
/* >button: direct trigger only; the emoji popover is nested inside .funcs
   and its inner buttons must keep the verbatim .emoji-panel styles */
.comment-form .funcs>button{
  display:inline-flex; align-items:center; justify-content:center;
  width:36px; height:32px; padding:0; border:0; cursor:pointer;
  background:transparent; color:var(--muted); transition:color .15s ease;
}
.comment-form .funcs>button:hover{ color:var(--accent); }

.comment-form .guest-info{ display:flex; gap:8px; margin-bottom:12px; position:relative; z-index:1; }
.comment-form .guest-info .item{ position:relative; flex:1 1 0; min-width:0; }
.comment-form .comment-field{
  width:100%; height:38px; padding:0 10px 0 34px;
  font-size:13px; font-family:inherit; outline:none;
  background:var(--surface, #fff);
  border:1px solid var(--border, rgba(144,147,153,.35));
  border-radius:8px; color:var(--text, #1f2937);
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
  border:0; background:transparent;
}
.comment-form .comment-field:focus + i{
  color:var(--accent);
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
// Emoji popover visibility + the open/close motion. NOTE ON WHAT ACTUALLY FIXED THE FIRST-OPEN ANIMATION: it was NOT this block.
@media (prefers-reduced-motion:reduce){
  .emoji-panel-wrap .emoji-panel{ transition:none; }
}
.emoji-panel{
  position:absolute; left:0; bottom:calc(100% + 6px); z-index:30;
  padding:1em; font-size:15px; border-radius:10px;
  background:var(--surface, #fff);
  border:1px solid var(--border, rgba(0,0,0,.12));
  box-shadow:0 10px 28px rgba(0,0,0,.18);
}
.emoji-panel:before{ content:none; }
/* Auto-flipped below the trigger when there is no room above (set by comments.js). */
.emoji-panel-wrap.is-below .emoji-panel{ top:calc(100% + 6px); bottom:auto; }
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

.emoji-panel-wrap{ position:relative; display:inline-block; width:0; height:0; vertical-align:middle; }
.emoji-panel-wrap .emoji-panel{
  left:0; bottom:calc(100% + 10px);
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

// Comments are ~23KB of the default theme's assembled sheet (11.9KB in
// default.css, 8.2KB in default-extra.css, the rest in the shared baseline),
// and brotli cannot squeeze prose - they cost ~8KB of every transferred
// document (measured: the home page goes 31.2KB -> 23.0KB brotli). Removing
// them changes no selector and no declaration.
//
// Whitespace is deliberately left alone. Collapsing it safely means reasoning
// about quoted strings ("Apple Color Emoji", url() data URIs), calc() operands
// (a space around + / - is required) and descendant selectors (a > b vs a>b) -
// a regex that gets any of those wrong breaks a theme silently in production.
// The bytes it would win are already free once the document is compressed.
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// The assembled sheet is byte-identical for every request until a theme file
// changes, and assembling it concatenates ~100KB and runs the comment pass over
// the result. Keyed on both source mtimes: a theme edit (dev, or an upload
// through admin) changes the key and the next request rebuilds.
let cssContentCache = new Map<string, string>();

function minifyCss(css: string): string {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      out += ch;
      continue;
    }
    if (ch === ")") {
      depth = depth > 0 ? depth - 1 : 0;
      out += ch;
      continue;
    }
    if (depth > 0) {
      out += /\s/.test(ch) ? (out[out.length - 1] === " " ? "" : " ") : ch;
      continue;
    }
    if (/\s/.test(ch)) {
      const last = out[out.length - 1];
      if (last !== undefined && last !== " " && last !== "{" && last !== "}" && last !== ";" && last !== ":" && last !== ",") {
        out += " ";
      }
      continue;
    }
    if (ch === "{" || ch === "}" || ch === ";" || ch === ":" || ch === ",") {
      if (out[out.length - 1] === " ") out = out.slice(0, -1);
      out += ch;
      continue;
    }
    out += ch;
  }
  return out.replace(/;}/g, "}").trim();
}

export function themeCssContent(slug: string): string {
  // Skyscraper is served from /public/theme.css, not this route. Returning ""
  // made /theme-style/skyscraper answer 404 with a 9-byte body, which reads
  // like a broken deploy; the middleware maps falsy to that bare 404, so the
  // empty string is load-bearing and only the comment was missing.
  if (slug === "skyscraper") return "";
  // readThemeCss answers { css: "", mtime: 0 } for a missing file, so the
  // optional -extra.css needs no try/catch and its mtime is a valid key half.
  const main = readThemeCss(slug, slug + ".css");
  const extra = readThemeCss(slug, slug + "-extra.css");
  const key = slug + ":" + main.mtime + ":" + extra.mtime;
  const hit = cssContentCache.get(key);
  if (hit !== undefined) return hit;
  const body = extra.css ? main.css + "\n" + extra.css : main.css;
  const out = minifyCss(stripCssComments(SHARED_FORM_BASELINE + GLOBALS_BODY_UTILITIES + body));
  // One entry per theme is plenty: a theme edit replaces it, never grows it.
  cssContentCache = new Map([[key, out]]);
  return out;
}

// ------------------------------------------------------------------- assets
// Serve /theme-assets/<slug>/<rel...> from themes/<slug>/assets/<rel...> on
// disk — direct port of the original app app/theme-assets/[...path]/route.ts
// (rankings medals, theme fonts, vendor scripts). GET/HEAD only; a crafted
// path that escapes the themes root is rejected (403/404).
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

// ============================================================= SKYSCRAPER

const skyscraperChrome: ThemeChrome = {
  slug: "skyscraper",
  cssHref: () => publicAssetHref("theme.css"),
  bodyFix: () => "",
  // Original parity (Layout.tsx:59,108): restore the saved color scheme
  // BEFORE first paint — an external head script (no defer) runs ahead of
  // the body, so dark-mode visitors never flash the light theme.
  headExtra: () => fontPreloadLinks("bluemix") + `<script src="${publicAssetHref("noflash.js")}" defer></script>`,
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
    R.postPage(parts.post, parts.related, parts.commentsHtml, parts.metaItems ?? [], parts.bodyHtml, parts.blogIndex),
  pagePage: (parts) =>
    R.pagePage(parts.page, parts.recent, parts.commentsHtml, parts.bodyHtml),
};

// ================================================================ DEFAULT
//
// Faithful port of themes/default (Layout.tsx + HomePage.tsx + PostCard + Sidebar
// + PostPage). We keep the exact utility classes the original emits and
// implement them in themes/default/default.css (token-driven), so the two
// stacks share one visual contract. rosefd builders receive no category/tag
// sidebar rows on list/post pages, so content flows single-column while the
// header/hero/card/footer — the visible "face" — match the original exactly.

// Anti-FOUC base tint only — mirrors the theme stylesheet's own `body` rule
// (pre-CSS-frame flash guard); no `!important`, no forced override on <html>.
const defaultBodyFix = `<style id="rv-body-fix">body{background:var(--bg,#09090b);color:var(--text,#f4f4f5)}</style>`;

// ---------------------------------------------------------------------------
// Fallback icons for categories and nav items.
//
// Categories/menus ship from the database with `icon: null` unless an editor
// set one in admin, which left the front end with bare text (the "no icons"
// symptom). When an item has no icon of its own we fall back to a slug-derived
// glyph so the UI looks complete out of the box; an explicitly set icon always
// wins. Every name here is verified present in public/icons/*.svg.
// ---------------------------------------------------------------------------
const CATEGORY_ICON_MAP: Record<string, string> = {
  prose: "book-open",
  poetry: "feather",
  linux: "terminal",
  matlab: "sigma",
  android: "folder-kanban",
  skill: "wrench",
  share: "share-2",
  tool: "package",
  stm32: "cpu",
  stc32: "cpu",
  esp32: "wifi",
  zigbee: "radio",
  embedded: "circuit-board",
  html: "code",
  python: "code",
  elanguage: "code",
  php: "code",
  code: "code",
  default: "folder",
};

export function catIconName(c: { slug?: string | null; icon?: string | null }): string {
  const set = c.icon && String(c.icon).trim();
  if (set) return set;
  if (c.slug && CATEGORY_ICON_MAP[c.slug]) return CATEGORY_ICON_MAP[c.slug];
  return CATEGORY_ICON_MAP.default;
}

const MENU_ICON_MAP: Record<string, string> = {
  "/": "house",
  "/links": "network",
  "/maxim": "quote",
  "/board": "message-square",
};

function menuIconName(it: MenuItem): string {
  const set = it.icon && String(it.icon).trim();
  if (set) return set;
  if (it.url && MENU_ICON_MAP[it.url]) return MENU_ICON_MAP[it.url];
  if (it.label && MENU_ICON_MAP[it.label]) return MENU_ICON_MAP[it.label];
  return "";
}

/**
 * One search field: a real GET form plus the combobox wiring that
 * theme-pjax.js drives.
 *
 * `panelId` MUST be unique per rendered field. The suggestion panel is looked
 * up by id (`aria-controls` -> getElementById) and two fields sharing one id
 * means both write into the same element, so whichever input the visitor types
 * into repaints the other one's list. The three call sites are the header
 * field, the sidebar field and the mobile menu field - all on the same page.
 *
 * The panel is a SIBLING of the box, not a child: the box is a flex row
 * (glyph + input + kbd), so a child panel becomes a third flex item and sits
 * BESIDE the field instead of under it.
 */
function searchField(
  panelId: string,
  placeholder: string,
  label: string,
  formClass: string,
): string {
  return (
    `<form action="/search" method="get" class="${formClass}" role="search">` +
    `<span class="df-search-box">` +
    lucideSvg("search", 16, dfSearchIcon()) +
    `<input name="q" placeholder="${esc(placeholder)}" class="df-search-input" autocomplete="off"` +
    // role=combobox + aria-* is what turns the field into a combobox for a
    // screen reader; without it the suggestion list appears with no announced
    // relationship to the input. aria-expanded is flipped by theme-pjax.js.
    ` role="combobox" aria-expanded="false" aria-autocomplete="list"` +
    ` aria-controls="${panelId}" aria-label="${esc(label)}">` +
    `<kbd class="df-search-kbd">/</kbd>` +
    `<div class="df-suggest" id="${panelId}" hidden></div>` +
    `</span></form>`
  );
}

/** The search field inside the mobile menu drawer. */
function mobileSearchField(): string {
  return searchField(
    "df-suggest-mobile",
    "搜索文章…",
    "搜索文章",
    "df-search-form df-search-form-mobile",
  );
}

/**
 * Render a menu list.
 *
 * `highlight` decides whether the "current page" marker is applied at all, and
 * it defaults to TRUE only for the header nav. The footer menu passes false:
 * the footer is site information, not a position indicator, and it was
 * lighting up "Home" on every page of the site. That happened because `path`
 * defaults to "" and norm() maps "" to "/", so the home item - whose rule is
 * `cur === "/" -> href === "/"` - always matched. Passing an empty path is
 * therefore NOT the same as passing no path, which is the whole trap.
 */
function defaultMenuUl(
  items: MenuItem[],
  cls: string,
  path = "",
  highlight = true,
): string {
  if (!items.length) return "";
  // The menu item's own icon leads the label. It was dropped here, so an icon
  // saved in admin/menus never reached the front end at all.
  const link = (it: MenuItem, extra: string) => {
    const mic = menuIconName(it);
    const ic = mic
      ? `<span class="df-menu-ic">${lucideSvg(mic, 14)}</span>`
      : "";
    // "Where am I" is decided HERE, on the server, from the real pathname -
    // not in the browser from a scroll observer. The header is re-rendered on
    // every navigation but the page body is swapped by pjax, so a client-side
    // highlight would always be one navigation behind, and it would need the
    // section list to exist before it could run at all.
    //
    // Trailing slashes are normalised on both sides: "/category/x/" and
    // "/category/x" are the same page to a reader, and treating them as
    // different leaves the highlight off on one of them.
    const norm = (s: string) => s.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
    const cur = norm(path);
    const href = norm(it.url || "");
    // Two forms, and the exact match has to be listed separately: the prefix
    // test alone ("does the current path start with href + /") is false for a
    // path that EQUALS href, so "/links" would never light up its own item.
    // That is not a corner case - it is the common case, every top-level page.
    // "/" is excluded from the prefix branch on purpose, or it would match
    // every path on the site and light up "Home" everywhere.
    const isCurrent =
      highlight &&
      (cur === "/"
        ? href === "/"
        : href !== "/" && (cur === href || cur.indexOf(href + "/") === 0));
    return `<a href="${esc(it.url)}"${it.target && it.target !== "_self" ? ` target="${esc(it.target)}" rel="noopener"` : ""} class="df-menu-link${isCurrent ? " is-current" : ""} ${extra}"${isCurrent ? ' aria-current="page"' : ""}>${ic}<span>${esc(it.label)}</span></a>`;
  };
  const lis = items
    .map((it) => {
      const kids = it.children?.length
        ? `<ul class="df-menu-sub">` +
          (it.children || [])
            .map((c) => `<li>${link(c, "hover:text-white")}</li>`)
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
  // No "" fallback here. norm("") maps to "/", so an absent __pathname made
  // the home item match on EVERY page - the highlight said "you are here" for
  // a position the server never actually knew. A missing path now highlights
  // nothing, which is the honest answer; the header still renders.
  const here = settings.__pathname == null ? "" : String(settings.__pathname);
  const menu = defaultMenuUl(items, "df-menu-list", here);
  const hasMenu = items.length > 0;

  // Mobile menu: the desktop nav is hidden below md, so narrow viewports had
  // no way to reach the menu at all. A <details> disclosure needs no script
  // (the theme ships no nav JS) and keeps the same markup for both layouts.
  //
  // It carries the search field too, not just the links. Without it a phone
  // visitor had to leave the menu to search at all: the header search box is
  // inside `hidden ... md:block`, so it does not exist below md, and the
  // sidebar one is further down the page. The field is a second copy with its
  // own suggestion panel id - the header one drives df-suggest-header and
  // two elements must never share a panel.
  const mobileMenu = hasMenu
    ? `<details class="dfm-menu md:hidden">` +
      `<summary class="dfm-burger" aria-label="打开菜单">${lucideSvg("menu", 20)}</summary>` +
      `<div class="dfm-panel">` +
      mobileSearchField() +
      defaultMenuUl(items, "dfm-list", here) +
      `</div>` +
      `</details>`
    : "";

  return `<div class="theme-root relative flex min-h-screen flex-col">` +
    `<header class="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]">` +
    `<div class="relative mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">` +
    `<a href="/" class="flex items-center gap-2 text-lg font-bold tracking-tight ${headingClass}">${brandLink}</a>` +
    `<nav class="ml-2 hidden flex-1 md:block">${menu}</nav>` +
    // The search form carries ml-auto so it stays right-aligned; on narrow
    // viewports the burger follows it and takes the trailing slot.
    // The glyph is a flex item inside a bordered pill rather than an
    // absolutely-positioned overlay: absolute positioning depended on a
    // `relative` wrapper plus a pl-9 pad, and any ancestor that failed to
    // establish the containing block let the icon escape the field.
    // The <kbd> advertises the "/" shortcut that theme-default.js binds, so the
    // affordance is visible before the visitor presses anything.
    searchField("df-suggest-header", "搜索…", "搜索文章", "df-search-form") +
    mobileMenu +
    `</div></header>`;
}

function defaultFooter(settings: Record<string, any>, widgetsHtml: string): string {
  const year = new Date().getFullYear();
  const copy = esc(settings.footerText || `© ${year} ${settings.siteTitle}`);
  const menu = defaultMenuUl(
    (settings.footerMenu as MenuItem[]) || [],
    "df-menu-list df-menu-list-foot",
    "",
    false,
  );
  return `<footer class="relative border-t border-[var(--border)] bg-[var(--footer-bg)] px-4 py-8">` +
    `<div class="mx-auto max-w-5xl">` +
    (widgetsHtml ? `<div class="mb-6">${widgetsHtml}</div>` : "") +
    (menu ? `<nav class="mb-4">${menu}</nav>` : "") +
    // --muted (zinc-400), not text-zinc-500. Lighthouse flagged this line:
    // zinc-500 on the footer background is the only contrast failure left on
    // the page, and it held accessibility at 96/100. Every other muted-text
    // position in this theme already uses the variable, so this was the odd one
    // out rather than a considered choice.
    `<p class="text-xs text-[var(--muted)]">${copy}</p>` +
    `</div></footer>`;
}

function defaultCatPill(c: { name: string; url?: string; icon?: string | null }): string {
  const label = esc(c.name);
  const cls = "df-cat-pill";
  // The category's own icon leads the pill. It was dropped here before, so a
  // category that had an icon set still rendered as bare text on the cards.
  const ic = `<span class="df-cat-pill-ic">${lucideSvg(catIconName(c), 12)}</span>`;
  return c.url
    ? `<a href="${esc(c.url)}" class="${cls}">${ic}${label}</a>`
    : `<span class="${cls}">${ic}${label}</span>`;
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
    `<span class="df-meta-item">${lucideSvg("user", 13)}${author}</span>` +
    `<span class="df-meta-item">${lucideSvg("calendar", 13)}${fmtDate(p.publishedAt)}</span>` +
    (p.commentsCount > 0 ? `<span class="df-meta-item">${lucideSvg("message-circle", 13)}${p.commentsCount} 评论</span>` : "") +
    `</div></div></article>`;
}

function defaultHome(parts: HomeParts): string {
  const siteTitle = esc((parts.settings.siteTitle as string) ?? "");

  const tagline = parts.settings.tagline ? `<p class="mt-3 text-base text-[var(--muted)]">${esc(parts.settings.tagline as string)}</p>` : "";
  const desc = parts.settings.siteDescription
    ? `<p class="mx-auto mt-3 max-w-2xl text-sm text-[var(--muted)]">${esc(parts.settings.siteDescription as string)}</p>`
    : "";
  const hero = `<section class="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-gradient-to-br from-[var(--surface)] to-[var(--bg)] px-8 py-12 text-center">` +
    lucideSvg("sparkles", 28, "df-hero-ic") +
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
      `<span class="df-featured-tag">${lucideSvg("sparkles", 13)} 推荐阅读</span>` +
      (featured.excerpt ? `<p class="mt-3 line-clamp-3 text-sm text-[var(--muted)]">${esc(featured.excerpt)}</p>` : "") +
      `</div></article>`;
  }
  const grid = rest.map((p, i) => defaultPostCard(p, i)).join("");

  return `<div class="space-y-10">${hero}` +
    `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><div><div class="space-y-6">${featuredHtml}` +
    (rest.length ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">${grid}</div>` : "") +
    `</div></div>${defaultAside(parts.cats || [], parts.tags || [], [...parts.hero, ...parts.latest].slice(0, 5), parts.settings, (parts.themeSettings as Record<string, any> | undefined)?.useCustomIcons === true, parts.catCounts)}</div></div>`;
}

function defaultAside(cats: TaxRef[], tags: TaxRef[], recent: PostView[], settings: Record<string, unknown>, showCatIcons = false, catCounts?: Map<number, number>): string {
  // ---- Category tree -------------------------------------------------------
  // The DB carries a real hierarchy (parentId), and the flat list this used to
  // render threw it away: a parent row and its children looked like unrelated
  // peers, so the sidebar read as 18 loose links instead of 5 groups.
  //
  // Roots are the rows with no parentId, plus any row whose parentId points at a
  // category that no longer exists - an orphan still has to be reachable, and
  // dropping it would hide content behind a link nobody can see. Children are
  // nested under their parent; anything unreachable (a cycle from bad data) is
  // promoted to a root rather than disappearing.
  const byId = new Map(cats.map((c) => [c.id, c]));
  const childOf = new Map<number, TaxRef[]>();
  const roots: TaxRef[] = [];
  for (const c of cats) {
    const pid = c.parentId;
    if (pid != null && pid !== c.id && byId.has(pid)) {
      (childOf.get(pid) ?? childOf.set(pid, []).get(pid)!).push(c);
    } else {
      roots.push(c);
    }
  }
  // A child reachable from two parents (impossible with a single parentId, but
  // cheap to rule out) or looped back to a root would render twice. Mark every
  // category that is claimed by exactly one parent as placed, then treat any
  // unplaced row as a root - that covers both a cycle and a row whose parent
  // chain dangles.
  const placed = new Set<number>();
  for (const [, kids] of childOf) for (const k of kids) placed.add(k.id);
  for (const c of cats) if (!placed.has(c.id) && !roots.includes(c)) roots.push(c);

  const countOf = (c: TaxRef): number | undefined => (catCounts ? catCounts.get(c.id) : undefined);

  // One row of the tree: icon, name, count. `depth` drives the indent so a
  // child reads as belonging to its parent.
  const catRow = (c: TaxRef, depth: number): string => {
    const n = countOf(c);
    return `<a href="${esc(c.url)}" class="df-cat df-cat-d${depth} text-[var(--text)] hover:text-[var(--accent)]">` +
      `<span class="df-cat-ic">${lucideSvg(catIconName(c), depth ? 13 : 14)}</span>` +
      `<span class="df-cat-name">${esc(c.name)}</span>` +
      (n != null ? `<span class="df-cat-n">${n}</span>` : "") +
      `</a>`;
  };

  // A group is a <details> element rather than a div + button: expand/collapse
  // then works with zero JavaScript, is keyboard-operable, keeps its state
  // across a pjax swap (the markup is re-inserted, not recreated), and needs no
  // id (which would collide once several sidebars render).
  //
  // The summary carries ONLY the disclosure control. A <summary> may not wrap
  // an <a> (interactive content inside a summary is not reachable - activating
  // the link toggles the group instead of navigating, and the browser is free
  // to drop the anchor entirely), so the parent's own link sits beside it as a
  // sibling. That also gives the parent row a real click target, which the
  // group-toggle-only version lacked.
  //
  // `open` on the first groups only: a 5-group tree all-collapsed looks broken,
  // all-open is taller than the sidebar.
  let openLeft = 2;
  const catTree = roots
    .map((r) => {
      const kids = childOf.get(r.id) ?? [];
      const n = countOf(r);
      if (!kids.length) {
        return `<li class="df-cat-li df-cat-li-leaf">${catRow(r, 0)}</li>`;
      }
      // A group's count is the sum of its own posts and its children's: a parent
      // usually holds no posts of its own, so showing only its own would make
      // every group read as zero.
      const total = kids.reduce((sum, k) => sum + (countOf(k) ?? 0), 0) + (n ?? 0);
      const open = openLeft-- > 0;
      const sub = kids.map((k) => `<li class="df-cat-li">${catRow(k, 1)}</li>`).join("");
      return `<li class="df-cat-li df-cat-li-group">` +
        `<details class="df-cat-group"${open ? " open" : ""}>` +
        `<summary class="df-cat-summary" title="展开/收起 ${esc(r.name)}">` +
        `<span class="df-cat-caret">${lucideSvg("chevron-down", 13)}</span>` +
        `<span class="df-cat-groupname">${esc(r.name)}</span>` +
        (total ? `<span class="df-cat-n">${total}</span>` : "") +
        `</summary>` +
        `<ul class="df-cat-sub">${sub}</ul>` +
        `</details>` +
        // The parent is also a destination: its own page lists whatever is
        // filed directly under it.
        `<a href="${esc(r.url)}" class="df-cat df-cat-parent text-[var(--text)] hover:text-[var(--accent)]" aria-label="${esc(r.name)}分类页">` +
        `<span class="df-cat-ic">${lucideSvg(catIconName(r), 14)}</span></a>` +
        `</li>`;
    })
    .join("");

  // ---- Recent posts & tags -------------------------------------------------
  const recentLis = recent
    .map(
      (p) =>
        `<li class="df-recent"><a href="${esc(p.url)}" class="df-recent-link text-[var(--text)] hover:text-[var(--accent)]">${esc(p.title)}</a>` +
        `<p class="df-recent-date">${fmtDate(p.publishedAt)}</p></li>`,
    )
    .join("");
  const tagPills = tags
    .map(
      (t) =>
        `<a href="${esc(t.url)}" class="df-tag text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]">#${esc(t.name)}</a>`,
    )
    .join("");
  const cardHead = (icon: string, label: string, extra = "") =>
    `<h3 class="df-card-head">${lucideSvg(icon, 15)}<span>${label}</span>${extra}</h3>`;
  const card = (inner: string, cls = "") => `<section class="df-card ${cls}">${inner}</section>`;

  return `<aside class="df-aside">` +
    // The sidebar search is a real field, not a decorative box: the label is
    // screen-reader only, and the icon sits inside the bordered pill as a flex
    // item (an absolutely-positioned overlay escaped the field whenever its
    // containing block was not established). It keeps its own <label for> and
    // the -block box modifier, so it is NOT routed through searchField() -
    // that helper exists for the two copies that share a shape.
    `<form action="/search" method="get" class="df-search-form df-search-form-block" role="search">` +
    `<label class="df-sr-only" for="df-aside-q">搜索文章</label>` +
    `<span class="df-search-box df-search-box-block">` +
    lucideSvg("search", 16, dfSearchIcon()) +
    `<input id="df-aside-q" name="q" placeholder="搜索文章…" class="df-search-input" autocomplete="off"` +
    ` role="combobox" aria-expanded="false" aria-autocomplete="list"` +
    ` aria-controls="df-suggest-aside" aria-label="搜索文章">` +
    `<kbd class="df-search-kbd">/</kbd>` +
    // Its own panel id: all three fields are on the same page and each drives
    // the list it points at.
    `<div class="df-suggest" id="df-suggest-aside" hidden></div>` +
    `</span></form>` +
    card(
      cardHead("folder", "分类") +
      `<ul class="df-cat-tree">${catTree || `<li class="df-empty">暂无分类</li>`}</ul>`,
      "df-card-tree",
    ) +
    card(cardHead("tags", "标签") + `<div class="df-tags">${tagPills || `<span class="df-empty">暂无标签</span>`}</div>`) +
    card(cardHead("clock", "最新文章") + `<ul class="df-recent-list">${recentLis || `<li class="df-empty">暂无文章</li>`}</ul>`) +
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
    `<a href="${esc(hrefFor(p))}" class="df-page-edge">${icon}${label}</a>`;
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
      return `<span class="df-meta-item">${inner}${last ? "" : lucideSvg("chevron-right", 12, "text-zinc-600")}</span>`;
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
  const iconHtml = parts.titleIcon ? lucideSvg(parts.titleIcon, parts.variant === "search" ? 26 : 22, dfIconAccent()) : "";

  const crumbItems: { label: string; href?: string }[] = [{ label: "首页", href: "/" }];
  if (isCategory) crumbItems.push({ label: "分类" });
  else if (isSearch) crumbItems.push({ label: "搜索" });
  else if (isTerm) crumbItems.push({ label: "标签" });
  else if (!isBlog) crumbItems.push({ label: "页面" });
  if (isSearch && (parts.query ?? "").trim()) {
    crumbItems.push({ label: (parts.query ?? "").trim() });
  } else {
    crumbItems.push({ label: parts.title.replace(/^(分类|标签|搜索)[：:]\s*/, "") || parts.title });
  }
  const backLink =
    `<div class="mb-6">` +
    defaultBreadcrumb(crumbItems) +
    `<h1 class="mt-2${isTerm ? "" : " flex items-center gap-2"} text-3xl font-bold text-zinc-100">` +
    (isTerm ? "" : iconHtml) +
    esc(parts.title) +
    `</h1>` +
    (parts.titleDesc
      ? `<p class="mt-2 text-sm text-zinc-400">${esc(parts.titleDesc)}</p>`
      : parts.sub
        ? `<p class="mt-2 text-sm text-zinc-400">${esc(parts.sub)}</p>`
        : "") +
    `</div>`;
  const headHtml = isBlog
    ? defaultBreadcrumb([{ label: "首页", href: "/" }, { label: "文章" }]) +
      `<header class="mb-6 mt-3">` +
      `<h1 class="text-3xl font-bold text-zinc-100">${esc(parts.title)}</h1>` +
      (parts.sub ? `<p class="mt-1 text-sm text-[var(--muted)]">${esc(parts.sub)}</p>` : "") +
      `</header>`
    : backLink;
  const sidebar = parts.sidebarData
    ? defaultAside(parts.sidebarData.cats, parts.sidebarData.tags, parts.sidebarData.posts, parts.settings || {}, parts.sidebarData.showCatIcons === true, parts.sidebarData.catCounts)
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


/**
 * The share block's markup. NO script here.
 *
 * The copy button used to ship an inline `<script>` next to the buttons, and
 * that is why it worked only when the article was opened directly: the block
 * renders inside `<main id="sk-main">`, and a pjax navigation replaces that
 * subtree with `main.innerHTML = ...`. The HTML parser ignores every script
 * inside markup inserted that way, so on every client-side navigation the new
 * page's copy button arrived with nothing bound to it and did nothing when
 * clicked — no error, no console message, just a dead button.
 *
 * The handler now lives in /public/theme-pjax.js, which is loaded once from
 * `<head>` and therefore survives every swap. That file already documents this
 * class of bug; this entry is the second consumer of the same rule.
 */
function defaultShareButtons(title: string, url: string): string {
  // https, not http: on an HTTPS site an http:// share link is mixed content,
  // so the browser either blocks it or first loads it over plaintext, leaking
  // the visited URL and getting the visitor flagged by Weibo's own gateway.
  const wb = `https://service.weibo.com/share/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`;
  // x.com/intent/post is the current endpoint; intent/tweet still redirects, but linking the retired one is an extra hop for no reason.
  const x = `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`;
  const mail = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`;
  const btn = "df-share-btn";
  // data-url is left empty on purpose: theme-pjax.js falls back to
  // location.href, which is the page the visitor is actually looking at. The
  // server-rendered absolute URL is the page as of render time, and pjax has
  // no way to rewrite an attribute on the markup it swaps in.
  return `<div class="df-share">` +
    `<span class="df-share-label">${lucideSvg("share-2", 15)}分享</span>` +
    `<button type="button" data-share-copy title="复制文章链接" class="${btn}">` +
    `${lucideSvg("link", 13)}<span data-share-label>复制链接</span></button>` +
    `<a href="${esc(wb)}" target="_blank" rel="noopener noreferrer" class="${btn}">微博</a>` +
    // Plain text: lucide's `x` is the close glyph, and a brand logo is not
    // worth shipping an icon file for.
    `<a href="${esc(x)}" target="_blank" rel="noopener noreferrer" class="${btn}" aria-label="分享到 X">X</a>` +
    `<a href="${esc(mail)}" class="${btn}">${lucideSvg("mail", 13)}邮件</a>` +
    `</div>`;
}

/**
 * Live view counts. No script here either — see defaultShareButtons.
 *
 * The article HTML is render-cached for up to 15s, so the count in the markup
 * can be stale; the real number is fetched after load and written into the
 * [data-views-count] slot. That "after load" has to be driven from
 * theme-pjax.js on the rv:nav event, because this block renders inside
 * <main id="sk-main"> and pjax replaces that subtree wholesale: an inline
 * script inside it runs on a direct page load and then never again, which is
 * why the count stayed at the cached value after a client-side navigation.
 */

function defaultRelatedSection(posts: PostView[]): string {
  if (!posts.length) return "";
  const cards = posts.map((p) =>
    `<a href="${esc(p.url)}" class="group rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--accent)]">` +
    `<h3 class="line-clamp-2 font-medium text-zinc-100 transition group-hover:text-[var(--accent)]">${esc(p.title)}</h3>` +
    (p.publishedAt ? `<p class="mt-2 text-xs text-[var(--muted)]">${fmtDate(p.publishedAt)}</p>` : "") +
    `</a>`).join("");
  return `<section class="mt-10">` +
    `<h2 class="mb-4 flex items-center gap-2 text-lg font-bold text-zinc-100">${lucideSvg("folder-open", 18, dfIconAccent())}相关文章</h2>` +
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
  // Table of contents from the body's own h2/h3 anchors (addHeadingIds stamps
  // id="<slug>-h<n>" at render). Native <details>: no JS, collapsed by default
  // so short-ish posts with one or two headings stay uncluttered. Hidden
  // entirely when the body has fewer than two headings.
  const tocItems = [...parts.bodyHtml.matchAll(/<h([23])[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map((m) => ({ level: Number(m[1]), id: m[2], text: m[3].replace(/<[^>]*>/g, "").trim() }))
    .filter((h) => h.text);
  const tocHtml =
    tocItems.length >= 2
      ? `<details class="df-toc mb-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">` +
        `<summary class="cursor-pointer text-sm font-semibold text-[var(--text)]">目录</summary>` +
        `<ul class="mt-3 space-y-1.5 text-sm">` +
        tocItems
          .map(
            (h) =>
              `<li${h.level === 3 ? ' class="ml-4"' : ""}><a href="#${esc(h.id)}" class="text-[var(--muted)] hover:text-[var(--accent)]">${esc(h.text)}</a></li>`,
          )
          .join("") +
        `</ul></details>`
      : "";
  return `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><article>` +
    `<header class="mb-6">` +
    // No "back to home" link above the title. The header already carries the
    // site brand as a link to "/", so this was a second control to the same
    // place competing with the breadcrumb right below it.
    crumb +
    (cats ? `<div class="mb-3 mt-3 flex flex-wrap gap-2 text-xs">${cats}</div>` : "") +
    `<h1 class="text-3xl font-bold leading-tight text-[var(--text)]">${esc(p.title)}</h1>` +
    `<div class="mt-3 flex flex-wrap items-center gap-4 text-sm text-[var(--muted)]">` +
    `<span class="df-meta-item">${lucideSvg("user", 14)}${author}</span>` +
    `<span class="df-meta-item">${lucideSvg("calendar", 14)}${fmtDate(p.publishedAt)}</span>` +
    `<span class="df-meta-item" data-views-post="${p.id}">${lucideSvg("eye", 14)}<span data-views-count>${p.views}</span> 阅读</span>` +
    (p.commentsCount > 0 ? `<span class="df-meta-item">${lucideSvg("message-circle", 14)}${p.commentsCount} 评论</span>` : "") +
    `</div>${meta}</header>` +
    (p.featuredImage ? `<img src="${esc(p.featuredImage)}" alt="${esc(p.title)}" class="mb-6 w-full rounded-2xl border border-[var(--border)] object-cover">` : "") +
    tocHtml +
    `<div class="prose-cms">${parts.bodyHtml}</div>` +
    (tags || "") +
    defaultShareButtons(p.title, parts.canonical || p.url) +
    defaultRelatedSection(parts.relatedTaxonomy || []) +
    (parts.postBottom || "") +
    parts.commentsHtml +
    `</article>` +
    `<div class="space-y-6">` +

    (parts.sidebarData
      ? defaultAside(parts.sidebarData.cats, parts.sidebarData.tags, parts.sidebarData.posts, parts.settings || {}, parts.sidebarData.showCatIcons === true, parts.sidebarData.catCounts)
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
  // Inlined; see ThemeChrome.cssInline. This is the theme the measurement was
  // taken on, and it is also the one whose CSS is assembled from three sources
  // (the shared form baseline, the body utilities and two files) - so a single
  // <link> was the only way to ship it, and the only thing on the critical path.
  cssInline: () => themeCssContent("default"),
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

// ============================================================= PSEUDOLINEAR

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

// ================================================================= CODEMAN
//
// Faithful port of themes/codeman (Layout + HomePage + ListPages + PostPage).
// The TTY/CRT aesthetic: cm-section shells, N° reverse-numbered cards, prompt
// eyebrows. Widgets render inside cm-side blocks exactly like the original.


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
  // Original parity (CodeManNav.tsx:9-12,22): an unconfigured header menu
  // falls back to the home/blog pair instead of an empty terminal bar.
  const list: MenuItem[] = items.length
    ? items
    : [
        { id: "__index", label: "home", url: "/" },
        { id: "__archive", label: "blog", url: "/blog" },
      ];
  const links = list
    .map(
      (it) =>
        `<li><a href="${esc(it.url)}"${it.target ? ` target="${esc(it.target)}"` : ""}` +
        ` data-active="${bmixNavActive(settings, it.url) ? "true" : "false"}">${esc(it.label)}</a></li>`,
    )
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
  
  //   blog     → total = ${published}
  //   category → ${items.length} files
  //   search   → ${items.length} matches / "—"
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

// ================================================================= BLUEMIX

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
  const align =
    settings.footerContainerAlign === "left"
      ? "0 auto"
      : settings.footerContainerAlign === "right"
        ? "auto 0"
        : "auto";
  
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
    `<div class="container-np px-10" style="margin-inline:${align}">` +
    `<div class="text-right text-primary-gray text-bulge-primary-gray">${copyright}</div>` +
    
    `<div class="mt-4 flex flex-wrap gx-8 gy-3 justify-end">${linksHtml}</div>` +
    `</div></footer>`;
}

// -------------------------------------------------------------------- bluemix

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
  if (a.length >= 2) return { title1: a[0], title2: a.slice(1).join(" · ") };
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
  const common = `overflow="visible" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-0.125em;flex-shrink:0;${mr}"`;
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
    "align-justify": "M21 10H3M21 14H3M21 6H3M21 18H3",
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


/**
 * Class for icons rendered inside prose/meta rows.
 *
 * These classes must be real rules in each theme's stylesheet: lucideSvg()'s
 * `cls` argument is a runtime string, so Tailwind's scanner never sees it and
 * never emits the utility. Passing text-[var(--muted)] here therefore produced
 * an unstyled icon - the date/meta glyphs read as "broken" while the markup
 * looked correct. Semantic classes are declared in the theme CSS instead.
 *
 * Functions, not consts: the default-theme chrome above is defined before this
 * point in the file but only RUNS at request time, and a const declared here
 * would still be in its temporal dead zone for any call made before it.
 */
function dfIcon(): string {
  return "df-ic";
}
function dfIconAccent(): string {
  return "df-ic df-ic-accent";
}
function dfSearchIcon(): string {
  return "df-search-ic";
}

function lucideSvg(name: string, px: number, cls = "", styleExtra = ""): string {
  let svg = iconFileCache.get(name);
  if (svg === undefined) {
    try { svg = fs.readFileSync(path.join(PUBLIC_DIR, "icons", `${name}.svg`), "utf8"); }
    catch { svg = null; }
    iconFileCache.set(name, svg);
  }
  if (!svg) return "";
  const c = cls ? ` ${cls}` : "";
  const style = `display:inline-block;vertical-align:-0.125em;flex-shrink:0${styleExtra ? ";" + styleExtra : ""}`;
  
  
  return svg
    // Strip the root <svg>'s width/height only - the next line re-adds them at
    // the call site's size, and the viewBox does the actual scaling.
    //
    // The pattern is ANCHORED to the root tag on purpose. An unanchored
    // /\s(?:width|height)="\d+"/g also matches nested elements, and those
    // dimensions are GEOMETRY, not presentation: a <rect> without a width does
    // not render at all. That silently emptied every rect in cpu.svg, book-open
    // and the rest, so those glyphs came out with rectangular holes.
    // Two passes, because the two attributes are independent.
    .replace(/^(<svg\b[^>]*?)\s(?:width|height)="\d+"/, (m, head) => head)
    .replace(/^(<svg\b[^>]*?)\s(?:width|height)="\d+"/, (m, head) => head)
    .replace(/^<svg\b[^>]*?\bxmlns="[^"]*"/, (m) => `${m} width="${px}" height="${px}"`)
    .replace(/stroke="#[0-9a-fA-F]{3,8}"/, 'stroke="currentColor"')
    // Glyphs that draw to y=2 / y=22 lose another 1px to the 2px stroke, and
    // the default svg overflow:hidden clips it - those icons render sliced.
    .replace(/^<svg\b/, '<svg overflow="visible"')
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
  // mirror PostCard.tsx useArtworkTint(wrapRef, themeColor ? undefined : image, 1)：
  
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

// ---------------------------------------------------- bluemix home sub-builders
// (mirror themes/bluemix/{Banner,ThemeSidebar,CatNav,Rankings,HomePage}.tsx DOM)

function bmixHeroScene(p: PostView, i: number): string {
  const { title1, title2 } = bmixSplitTitle(p.title);
  // mirror Banner.tsx：cardToneFor(h.slug, {bluemix_card_theme: h.themeColor}, i)
  
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

function bmixHomeSidebar(posts: PostView[], settings: Record<string, unknown>, ts: Record<string, unknown>, widgetsHtml = ""): string {
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
  // Original ThemeSidebar.tsx wraps the avatar in a link when sidebarAvatarLink
  // is set (external links get target/rel); the <a> carries the same style.
  const avatarHref = typeof (ts as any)?.sidebarAvatarLink === "string" ? (ts as any).sidebarAvatarLink.trim() : "";
  const external = /^https?:\/\//i.test(avatarHref);
  const avatarNode = avatarHref
    ? `<a href="${esc(avatarHref)}" class="avatar-link"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}><span class="avatar" style="${avatarStyle}"></span></a>`
    : `<div class="avatar" style="${avatarStyle}"></div>`;
  const bloggerDesc = String(settings.tagline ?? settings.siteDescription ?? "Design a colorful life");
  return `<div class="panel"><div class="wrapper"><aside class="bmx-blocks">` +
    `<div class="widget-blogger flex items-center g-8">${avatarNode}<div class="metas"><div class="name">${esc(String(settings.siteTitle ?? ""))}</div><div class="description text-embossed">${esc(bloggerDesc)}</div></div></div>` +
    `<div class="widget-title"><div class="title">热门文章</div></div><div class="widget-articles mb-20">${popular.map(bmixHomeArticleRow).join("")}</div>` +
    `<div class="widget-title"><div class="title">最新文章</div></div><div class="widget-articles mb-20">${(recent.length ? recent : items.slice(0, 4)).map(bmixHomeArticleRow).join("")}</div>` +
    widgetsHtml +
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
  const sidebar = bmixHomeSidebar(recent, parts.settings, ts as Record<string, unknown>, parts.sideWidgets || "");
  const catNav = bmixCatNav("/", parts.cats, parts.blogIndex || "/blog");
  const banner = showHero ? bmixBanner(recent, bannerMax) : "";
  const rankings = bmixRankings(parts.rankings, parts.rankTabs);
  const sections = (parts.sections || []).map((s) => `<div class="bmx-reveal">${bmixSection(s.row.title, s.row.category.url, s.row.icon, s.posts)}</div>`).join("");
  // Original HomePage.tsx places the `home-top` area between the banner and the
  // two-column body (className "container-np bmx-ad-area").
  const homeTop = parts.homeTop || "";
  return `<div class="home">` +
    banner +
    homeTop +
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

  
  const gridCls = isBlog || isCategory || isSearch ? "blog-grid" : "list-grid";
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
    `<li class="title" data-bmx-tab="bars"><a href="#" aria-label="大家喜欢" role="link" data-role="tab">${bmixIc("align-justify", 12, 0)}</a></li>` +
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
  // mirror PostPage.tsx: cardToneFor(post.slug, post.metas, 0) —— bgAlpha 0.8。
  const t = bmixCardTone(p.slug || p.url, 0, 0.8, p.metas);
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(";");
  const darkCls = t.dark ? " is-dark" : "";
  const hasImage = !!p.featuredImage;
  const imgUrl = hasImage ? esc(p.featuredImage!) : "";
  const date = fmtDate(p.publishedAt);
  // post.meta filter values (reading-time, . ) — the hero badge row; empty.
  // unless a plugin contributes, exactly like the original PostPage.tsx.
  const badges = parts.metaBadges ?? [];
  const bg = p.featuredImage
    ? `<div class="bg-wrapper"><img class="bg" src="${imgUrl}" alt="${esc(p.title)}" loading="eager"></div>`
    : `<div class="bg-wrapper"></div>`;
  // mirror PostPage.tsx skipTint={hasThemeColor}: a preset card theme pins
  // the surface, so the client artwork sampler must not repaint it.
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
    `<span class="bm-like-count" data-likes-for="${p.id}">${bmixIc("heart", 12)} <b class="bm-like-n">${p.likes ?? 0}</b></span>` +
    `<span class="ml-8">${bmixIc("comments", 12)} ${p.commentsCount ?? 0}</span>` +
    `<span class="ml-8">${bmixIc("eye", 12)} ${p.views ?? 0}</span>` +
    (date ? `<span class="ml-8">${bmixIc("clock", 12)} ${date}</span>` : "") +
    (badges.length ? badges.map((b) => `<span class="ml-8">${esc(b)}</span>`).join("") : "") +
    `</div></div>` +
    (hasImage ? `<img src="${imgUrl}" alt="" >` : "") +
    `</div></div></div>`;
  const sidebar = bmixPostSidebar(toc, p, parts.related || [], parts.popular || [], parts.random || []);
  // Original PostPage.tsx appends the `sidebar` widget area after PostSidebar
  // and renders `post-bottom` between the article and the comment block; both
  // arrive pre-wrapped from the loader (className bmx-ad-area /
  // model-wrapper bmx-ad-area) so the wrapper classes live in one place.
  const sideWidgets = parts.sidebarWidgets || "";
  const postBottom = parts.postBottom || "";
  return `<div class="single"><div data-post-type="article">` +
    `<div class="coverflow-swiper"><div class="container-np"><div class="slider mx-10">` +
    heroCard +
    `</div></div></div>` +
    `<div class="content-wrapper flex container-np line reverse">` +
    `<div class="sidebar"><div class="pf_scroller sidebar-sticky"><div class="sidebar-content">${sidebar}${sideWidgets}</div></div></div>` +
    `<div class="main-content">` +
    `<div class="model-wrapper article"><div class="model">` +
    `<article class="bmx-blocks" data-bmix-article>${bodyHtml}</article>` +
    parts.shareHtml +
    `</div></div>` +
    postBottom +
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
  headExtra: () => fontPreloadLinks("bluemix") + `<style id="rv-theme-bluemix-vars">${BLUEMIX_VARS}</style>`,
  nav: (settings, items) => bmixNav(settings, items),
  bodyOpen: (settings, items) =>
    
    
    `<div class="th-bluemix">` +
    `<svg width="0" height="0" aria-hidden="true" style="position:absolute"><defs><linearGradient id="bmx-cat-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="20%" class="bmx-g-s" stop-color="#33bbff"></stop><stop offset="80%" class="bmx-g-e" stop-color="#1f8bff"></stop>` +
    `</linearGradient></defs></svg>` +
    bmixNav(settings, items) +
    `<main id="sk-main"><div class="pf-route-frame pf-init" data-bmx-frame>`,
  
  bodyClose: (settings, footerHtml) => {
    // Original Layout.tsx:177-183 emits the theme's analytics code verbatim as
    // the last child of the theme wrapper, after the footer.
    const analytics = typeof settings.analyticsCode === "string" ? settings.analyticsCode.trim() : "";
    return (
      `</div></main>` +
      `<div class="full-loading show" aria-hidden="true"><div class="lines"><div></div><div></div><div></div><div></div><div></div></div></div>` +
      `<noscript><style>.full-loading{display:none!important}.pf-route-frame{opacity:1!important;transform:none!important}</style></noscript>` +
      footerHtml +
      (analytics ? `<div data-oboe="analytics">${analytics}</div>` : "") +
      `</div>`
    );
  },
  aside: () => "",
  footer: (settings, widgetsHtml) => bmixFooter(settings, widgetsHtml),
  home: bmixHome,
  listPage: bmixListPage,
  postPage: bmixPostPage,
  pagePage: bmixPagePage,
};

// ================================================================== REGISTRY

const registry = new Map<string, ThemeChrome>();
registry.set("skyscraper", skyscraperChrome);
registry.set("default", defaultChrome);
registry.set("pseudolinear", pseudolinearChrome);
registry.set("codeman", codemanChrome);
registry.set("bluemix", bluemixChrome);

export function getThemeChrome(slug: string): ThemeChrome {
  return registry.get(slug) ?? skyscraperChrome;
}
