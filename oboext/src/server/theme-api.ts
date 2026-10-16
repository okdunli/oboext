// Theme render API — everything a theme's chrome module may use. The program
// owns this module; every theme module imports from it and nothing else.
import fs from "fs";
import path from "path";
import type { PostView, TaxRef } from "./queries.js";
import type { PageView } from "./pages.js";
import * as R from "./render.js";
import { esc, fmtDate } from "./render.js";
import { mimeFor, PUBLIC_DIR } from "./storage.js";
import { DEFAULT_LOCALE, makeT, type Translate } from "./i18n.js";

export * as R from "./render.js";
export { esc, fmtDate } from "./render.js";
export { mimeFor, PUBLIC_DIR } from "./storage.js";
export { DEFAULT_LOCALE, makeT } from "./i18n.js";
export type { Translate } from "./i18n.js";
export type { PostView, TaxRef } from "./queries.js";
export type { PageView } from "./pages.js";

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
  /**
   * Optional theme-provided 404 body, rendered inside the shared 404 shell.
   * A theme with a designed not-found page ships it here; the program asks for
   * the capability instead of knowing which theme has one.
   */
  notFoundPage?(parts: {
    settings: { title: string; message: string; showSearch: boolean; showRecent: boolean };
    recent: { url: string; title: string }[];
    t?: Translate;
    homeHref?: string;
  }): string;
}

export type MenuItem = {
  id: number | string;
  label: string;
  url: string;
  target?: string;
  icon?: string | null;
  children?: MenuItem[];
};

export function cssUrl(v: string): string {
  return `url(&quot;${String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;")}&quot;)`;
}

/**
 * A translated chrome string. Every renderer receives the loaders' settings
 * bag, which carries the bound translator (settings.t) under a non-default
 * locale; the Chinese default catalog is the fallback when a renderer is
 * invoked without one. Untranslated keys fall back to Chinese by design
 * (catalog merge), so partial coverage renders sanely.
 */
export function tr(
  settings: Record<string, any> | undefined,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const t: Translate | undefined = settings && settings.t;
  if (typeof t === "function") return t(key, vars);
  return makeT(DEFAULT_LOCALE)(key, vars);
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

  /**
   * The breadcrumb's last item, locale-neutral. The loaders compose the
   * page title from a translated template ("分类：{name}" / "Category:
   * {name}"), so stripping the prefix back off with a regex would have to
   * know every locale's wording; passing the raw term name instead keeps
   * the crumb correct under any catalog.
   */
  crumbLast?: string;
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

  /** Previous/next navigation card (adjacent.ts adjacentHtml). Rendered after
   *  the comments block by every theme; empty string collapses the slot. */
  adjacentHtml?: string;

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

  settings?: Record<string, unknown>;
};

// ------------------------------------------------------------------- helpers

export const THEMES_DIR = path.join(process.cwd(), "themes");

/**
 * The public chrome LAYOUT DIALECT a theme builds for ("layout" in its
 * manifest). The program implements the dialects; a theme only declares which
 * one it uses, so a new theme needs no program change.
 */
const layoutCache = new Map<string, { layout: string; at: number }>();
/** How long a resolved dialect may be reused before re-reading the manifest.
 *  This sits on the RENDER path (every page binds it once), so the cache is
 *  consulted BEFORE any filesystem call: only a miss (or an expired entry,
 *  30s) pays a statSync. A dev edit is therefore picked up within 30s. */
const LAYOUT_TTL_MS = 30_000;
export function themeLayout(slug: string): string {
  const hit = layoutCache.get(slug);
  const now = Date.now();
  if (hit && now - hit.at < LAYOUT_TTL_MS) return hit.layout;
  try {
    const fp = path.join(THEMES_DIR, slug, "manifest.json");
    const m = JSON.parse(fs.readFileSync(fp, "utf-8")) as { layout?: string };
    const layout = m.layout || "default";
    layoutCache.set(slug, { layout, at: now });
    return layout;
  } catch {
    return "default";
  }
}

/**
 * The manifest-declared default theme (the folder carrying "isDefault": true).
 * The chrome registry falls back to it when asked for a slug no folder
 * provides, so no theme name is hardcoded in the program.
 */
export function defaultThemeSlug(): string | null {
  try {
    for (const name of fs.readdirSync(THEMES_DIR)) {
      const fp2 = path.join(THEMES_DIR, name, "manifest.json");
      if (!fs.existsSync(fp2)) continue;
      const m = JSON.parse(fs.readFileSync(fp2, "utf-8")) as { slug?: string; isDefault?: boolean };
      if (m && m.isDefault) return m.slug || name;
    }
  } catch {
    /* a theme-less tree simply has no default */
  }
  return null;
}


let cssCache = new Map<string, { css: string; mtime: number }>();

export function readThemeCss(slug: string, file: string): { css: string; mtime: number } {
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

// Preload a theme's declared fonts (manifest.json "fonts": [...]) so the
// browser fetches them alongside the stylesheet instead of after it.
export function fontPreloadLinks(slug: string): string {
  return (readThemeDecl(slug).fonts ?? [])
    .map(
      (f) =>
        `<link rel="preload" as="font" type="font/woff2" href="${themeAssetHref(slug, f)}" crossorigin>`,
    )
    .join("");
}

export const themeHrefCache = new Map<string, string>();
export function themeCssHref(slug: string): string {
  // Skyscraper's stylesheet is the build-time generated /public/theme.css (tools/gen.mjs inlines its fonts), so it never rides /theme-style/<slug>.
  if (slug === "skyscraper") return publicAssetHref("theme.css");
  const main = readThemeCss(slug, slug + ".css");
  const extra = readThemeCss(slug, slug + "-extra.css");
  const key = slug + ":" + main.mtime + ":" + extra.mtime;
  const hit = themeHrefCache.get(key);
  if (hit !== undefined) return hit;
  // The route answers `public, max-age=31536000, immutable`, so the stamp must
  // change whenever the bytes do. mtime cannot: Vercel normalizes deployed
  // file mtimes to one fixed epoch, so an mtime stamp is identical across
  // deploys and an edited stylesheet keeps its old URL for up to a year.
  const href =
    "/theme-style/" + slug + "?v=" + fnv1a32(Buffer.from(themeCssContent(slug), "utf8"));
  themeHrefCache.set(key, href);
  return href;
}

/**
 * Version stamp for /public/<file>. Served with an `immutable` year-long cache,
 * so the stamp must change with the bytes or returning visitors keep the old
 * build. Vercel freezes file mtimes to a fixed epoch, so an mtime stamp is
 * constant across deploys — we stamp a content hash instead. Cache keyed by
 * byte size so the file is only re-read when its length changes.
 */
export const assetVersionCache = new Map<string, { size: number; v: string }>();
export function fnv1a32(buf: Buffer): string {
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

// ------------------------------------------------------------------ theme assets
//
// Everything a theme owns on the client (its scripts, its fonts, its
// anti-FOUC bootstrap) is DECLARED in themes/<slug>/manifest.json and served
// from the theme's own folder. The program knows no theme by name: it reads
// the declaration. A theme-relative entry rides /theme-assets/<slug>/…; an
// entry in `publicScripts` is a program-owned asset under /public/.
// All paths are relative to the theme's assets/ directory.

export interface ThemeAssetDecl {
  scripts?: string[];
  publicScripts?: string[];
  noflash?: string;
  fonts?: string[];
}

export function readThemeDecl(slug: string): ThemeAssetDecl {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(THEMES_DIR, slug, "manifest.json"), "utf-8"),
    ) as ThemeAssetDecl;
  } catch {
    return {};
  }
}

export const themeAssetVersionCache = new Map<string, { size: number; v: string }>();
/** Versioned href for a theme asset: /theme-assets/<slug>/<rel>?v=<hash>. */
export function themeAssetHref(slug: string, file: string): string {
  const rel = String(file).replace(/^assets\//, "").replace(/^\/+/, "");
  const key = slug + ":" + rel;
  try {
    const fp = path.join(THEMES_DIR, slug, "assets", rel);
    const st = fs.statSync(fp);
    const cached = themeAssetVersionCache.get(key);
    if (cached && cached.size === st.size) {
      return `/theme-assets/${slug}/${rel}?v=${cached.v}`;
    }
    const v = fnv1a32(fs.readFileSync(fp));
    themeAssetVersionCache.set(key, { size: st.size, v });
    return `/theme-assets/${slug}/${rel}?v=${v}`;
  } catch {
    return `/theme-assets/${slug}/${rel}`;
  }
}

/** The theme's declared client scripts, in declaration order. */
export function themeScriptTags(slug: string): string {
  const d = readThemeDecl(slug);
  const tags: string[] = [];
  for (const f of d.publicScripts ?? []) {
    tags.push(`<script src="${publicAssetHref(f)}" defer></script>`);
  }
  for (const f of d.scripts ?? []) {
    tags.push(`<script src="${themeAssetHref(slug, f)}" defer></script>`);
  }
  return tags.join("");
}

/** Manifest-declared <head> extras: font preloads + the anti-FOUC bootstrap. */
export function themeHeadExtra(slug: string): string {
  const d = readThemeDecl(slug);
  const noflash = d.noflash
    ? `<script src="${themeAssetHref(slug, d.noflash)}" defer></script>`
    : "";
  return fontPreloadLinks(slug) + noflash;
}

export const GLOBALS_BODY_UTILITIES = `.min-h-screen{min-height:100vh}
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
.rv-ic{display:inline-block;vertical-align:-0.125em;flex-shrink:0;overflow:visible;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#rv-progress{position:fixed;top:0;left:0;height:3px;width:0;z-index:9999;background:var(--accent,#e91e63);transition:width .08s linear;pointer-events:none}
#rv-toc{position:fixed;top:50%;right:16px;transform:translateY(-50%);max-width:260px;max-height:72vh;overflow:auto;-webkit-overflow-scrolling:touch;background:var(--surface,#fff);border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:12px 14px;box-shadow:0 10px 34px rgba(0,0,0,.14);font-size:13px;line-height:1.5;z-index:9998;display:none}
#rv-toc.open{display:block}
#rv-toc h4{margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#888)}
#rv-toc ol{list-style:none;margin:0;padding:0}
#rv-toc li{margin:1px 0}
#rv-toc a{display:block;padding:3px 7px;border-radius:6px;color:var(--text,#222);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#rv-toc a:hover{background:color-mix(in srgb,var(--accent,#e91e63) 10%,transparent)}
#rv-toc a.active{color:var(--accent,#e91e63);font-weight:600;background:color-mix(in srgb,var(--accent,#e91e63) 12%,transparent)}
#rv-toc li.h3 a{padding-left:18px;font-size:12px;color:var(--muted,#666)}
#rv-toc-toggle{position:fixed;right:16px;bottom:22px;width:46px;height:46px;border-radius:50%;border:1px solid var(--border,#e5e7eb);background:var(--surface,#fff);color:var(--accent,#e91e63);font-size:20px;line-height:1;cursor:pointer;z-index:9998;box-shadow:0 6px 18px rgba(0,0,0,.14);display:none;align-items:center;justify-content:center}
#rv-toc-toggle.show{display:flex}
@media (max-width:768px){#rv-toc{right:10px;left:10px;max-width:none;transform:none;top:auto;bottom:80px}}
img{height:auto}
.prose-cms img,.post-content img,.bmx-blocks img,.cm-content img{max-width:100%;height:auto}
`;


export const SHARED_FORM_BASELINE = `
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
export function stripCssComments(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // CSS has no `//` line comment, but these sheets are authored with them.
    // Left in, the minifier folds the newline away and the parser then reads
    // the comment as part of the following rule's selector, silently dropping
    // that rule. Only whole-line `//` is stripped: a `//` inside a value is a
    // URL scheme (url(https://...)) and must survive.
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// The assembled sheet is byte-identical for every request until a theme file
// changes, and assembling it concatenates ~100KB and runs the comment pass over
// the result. Keyed on both source mtimes: a theme edit (dev, or an upload
// through admin) changes the key and the next request rebuilds.
let cssContentCache = new Map<string, string>();

export function minifyCss(css: string): string {
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

export function menuItemsHtml(items: MenuItem[], cls: string, activeUrl: string): string {
  return items
    .map(
      (it) =>
        `<a href="${esc(it.url)}"${it.target && it.target !== "_self" ? ` target="${esc(it.target)}" rel="noopener"` : ""}>${esc(it.label)}</a>`,
    )
    .join("");
}

export const CATEGORY_ICON_MAP: Record<string, string> = {
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

export const iconFileCache = new Map<string, string | null>();

export const LUCIDE_CLASS_ALIAS: Record<string, string> = { "share-2": "share2" };

export function bmixNavActive(settings: Record<string, any>, url: string): boolean {
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

export function dfIconAccent(): string {
  return "df-ic df-ic-accent";
}

export function dfSearchIcon(): string {
  return "df-search-ic";
}

export function lucideSvg(name: string, px: number, cls = "", styleExtra = ""): string {
  let svg = iconFileCache.get(name);
  if (svg === undefined) {
    try { svg = fs.readFileSync(path.join(PUBLIC_DIR, "icons", `${name}.svg`), "utf8"); }
    catch { svg = null; }
    iconFileCache.set(name, svg);
  }
  if (!svg) return "";
  const c = cls ? ` ${cls}` : "";
  const m = /^<svg\b([^>]*)>/.exec(svg);
  if (!m) return svg;
  const root = m[1]
    // xmlns, width/height, fill, stroke* and overflow are byte-for-byte
    // identical on every glyph and were re-serialized into every <svg> on every
    // page. They now live once in the shared `.rv-ic` rule (GLOBALS_BODY_UTILITIES)
    // that every document inlines, so each icon drops ~210 bytes while the page
    // pays a single ~150-byte rule. viewBox + the lucide class stay: the class
    // is the theme hook and the viewBox is the geometry the stroke scales.
    .replace(/\s*(?:xmlns|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|overflow)="[^"]*"/g, "")
    .replace(/\s*(?:width|height)="\d+"/g, "")
    .replace(/\s*class="[^"]*"/, ` class="lucide lucide-${LUCIDE_CLASS_ALIAS[name] || name} rv-ic${c}"`)
    .replace(/^\s+/, "");
  const style = styleExtra ? ` style="${styleExtra}"` : "";
  return `<svg ${root} width="${px}" height="${px}"${style}>` + svg.slice(m[0].length);
}

export function catIconName(c: { slug?: string | null; icon?: string | null }): string {
  const set = c.icon && String(c.icon).trim();
  if (set) return set;
  if (c.slug && CATEGORY_ICON_MAP[c.slug]) return CATEGORY_ICON_MAP[c.slug];
  return CATEGORY_ICON_MAP.default;
}

