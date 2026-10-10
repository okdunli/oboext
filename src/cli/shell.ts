// HTML shell - the document wrapper for every rosefd page.

import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { createHash } from 'crypto';

const OUT_DIR = path.join(process.cwd(), 'dist');

let clientCache: { mtimeMs: number; source: string } | null = null;

let splitMode = false;
export function setBundleMode(mode: string): void {
  splitMode = mode === 'split';
}

/** Read dist/client.js with an mtime-based cache (dev server rebuilds it). */
export function getClientSource(): string | null {
  if (splitMode) return null;
  const file = path.join(OUT_DIR, 'client.js');
  try {
    const st = fs.statSync(file);
    if (!clientCache || clientCache.mtimeMs !== st.mtimeMs) {
      clientCache = { mtimeMs: st.mtimeMs, source: fs.readFileSync(file, 'utf-8') };
    }
    return clientCache.source;
  } catch {
    return null;
  }
}

let styleCache: { mtimeMs: number; source: string } | null = null;

// Read dist/styles.css (every component's scoped <style>, merged at build time) with an mtime-based cache.
export function getStyles(): string {
  const file = path.join(OUT_DIR, 'styles.css');
  try {
    const st = fs.statSync(file);
    if (!styleCache || styleCache.mtimeMs !== st.mtimeMs) {
      styleCache = { mtimeMs: st.mtimeMs, source: fs.readFileSync(file, 'utf-8') };
    }
    return styleCache.source;
  } catch {
    return '';
  }
}

const BOOTSTRAP = esbuild.transformSync(`
const __app = document.getElementById('app');
// Native View Transitions around client-side navigation (progressive:
// browsers without the API navigate normally, no polyfill, no CSS required).
function __navigate(pathname) {
  const paint = () => start(__app, pathname);
  if (document.startViewTransition) {
    return document.startViewTransition(paint).updateCallbackDone;
  }
  return paint();
}
window.addEventListener('popstate', () => __navigate(window.location.pathname));
document.addEventListener('click', (e) => {
  const a = e.target.tagName === 'A' ? e.target : e.target.closest && e.target.closest('a');
  if (a && a.getAttribute('href') && a.getAttribute('href').startsWith('/')) {
    e.preventDefault();
    history.pushState(null, '', a.getAttribute('href'));
    __navigate(window.location.pathname);
  }
});
// Prefetch the target route's full render (including $data) on hover, keyboard
// focus, or touch - the click that follows paints from cache: no await, no
// request. Other frameworks prefetch data only; Rose Frame Driver prefetches the render
// because the inlined bundle already contains every route.
function __prefetchHandler(e) {
  const a = e.target.closest && e.target.closest('a[href^="/"]');
  if (a && prefetch) prefetch(a.getAttribute('href'), 'hover');
}
document.addEventListener('mouseover', __prefetchHandler);
document.addEventListener('focusin', __prefetchHandler);
document.addEventListener('touchstart', __prefetchHandler, { passive: true });
// Viewport + idle prefetch: once a link scrolls into view and the
// browser is idle, its route renders ahead of any interaction. trade-off: both
// APIs are feature-detected; without them the hover/focus/touch path above
// still covers every link.
if (prefetch && 'IntersectionObserver' in window && 'requestIdleCallback' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target); // one-shot per element; fresh links re-observe after nav
      requestIdleCallback(() => prefetch(e.target.getAttribute('href'), 'viewport'));
    }
  });
  // observing an already-observed element is a no-op, so re-sweeping is cheap
  const observeLinks = () => {
    for (const a of document.querySelectorAll('a[href^="/"]')) io.observe(a);
  };
  observeLinks();
  // navigation swaps the container's innerHTML: re-observe the fresh links
  const __rawNav = __navigate;
  __navigate = (p) => __rawNav(p).then(observeLinks, () => {});
}
// Progressive-enhancement forms: <form method="POST"> backed by a server
// action. With JS the submit is intercepted and handed to postForm (one
// request, in-place adopt). Without JS the browser performs the native POST
// and the server re-renders the page: the same form works with JavaScript
// disabled, which Server Actions in other frameworks do not.
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (!f || f.tagName !== 'FORM' || f.hasAttribute('data-on-submit')) return;
  if ((f.getAttribute('method') || '').toLowerCase() !== 'post') return;
  e.preventDefault();
  postForm(new FormData(f));
});
// initial=true: DOM is SSR output, resume state + wire markers (zero hydration).
// If the document was rendered for a DIFFERENT route (a static-file server's
// SPA fallback serves index.html for unknown paths), adopt nothing - let the
// client router render the requested route from scratch.
const __st = document.getElementById('__rosefd_state');
const __state = __st ? JSON.parse(__st.textContent || '{}') : {};
if (__state.__route === window.location.pathname) {
  start(__app, window.location.pathname, true);
} else {
  start(__app, window.location.pathname);
}
`, { minify: true }).code;

let cspCache: { for: string | null; value: string } | null = null;
const EXTERNAL_BOOTSTRAP = `\nimport { start, prefetch, postForm } from '/client.js';\n${BOOTSTRAP}`;
function inlineScript(client: string): string {
  return `\n${client}\n${BOOTSTRAP}`;
}
export function securityHeaders(client: string | null): Record<string, string> {
  if (!cspCache || cspCache.for !== client) {
    const scriptSrc = client
      ? `'sha256-${createHash('sha256').update(inlineScript(client), 'utf-8').digest('base64')}'`
      : `'self' 'sha256-${createHash('sha256').update(EXTERNAL_BOOTSTRAP, 'utf-8').digest('base64')}'`;
    cspCache = {
      for: client,
      value: `script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
    };
  }
  return { 'Content-Security-Policy': cspCache.value };
}

const FAVICON = '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'90\'>🌹</text></svg>">';

const STYLES = `
    body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; }
    button { padding: 0.5rem 1rem; font-size: 1rem; margin-right: 0.5rem; }
    a { color: #e91e63; text-decoration: none; font-weight: bold; }
    a:hover { text-decoration: underline; }
    nav a { margin-right: 1rem; }
    .rh { border-bottom: 2px solid #e91e63; margin-bottom: 1.5rem; padding-bottom: 0.75rem; }
    .rb { font-size: 1.25rem; }
    .rn { display: inline-block; margin-left: 1.5rem; }
    .rf { margin-top: 2rem; color: #888; font-size: 0.85rem; }
    ::view-transition-old(root), ::view-transition-new(root) { animation-duration: .18s; }
  `;

/**
 * Merge the route chain's <head> blocks (document order: page first, then its
 * layouts) into one clean <head> fragment. First occurrence wins per key, so a
 * page overrides its layouts - matching the client's reverse-order applyHead.
 */
function mergeHeadBlocks(blocks: string[]): string {
  const byKey = new Map<string, string>();
  const order: string[] = [];
  const put = (key: string, html: string) => {
    if (!byKey.has(key)) {
      byKey.set(key, html);
      order.push(key);
    }
  };
  for (const block of blocks) {
    for (const m of block.matchAll(/<title[^>]*>[\s\S]*?<\/title>/gi)) put('title', m[0]);
    for (const m of block.matchAll(/<(meta|link|base)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
      const tag = m[1].toLowerCase();
      const keyMatch = m[2].match(/\s(?:name|property|rel|charset)="([^"]*)"/i);
      const key = keyMatch ? `${tag}:${keyMatch[1]}` : tag;
      const marked = keyMatch ? m[0].replace(/^<\w+/, (t) => `${t} data-rosefd-head="${key}"`) : m[0];
      put(key, marked);
    }
  }
  return order.map((k) => byKey.get(k)!).join('\n  ');
}

/** The script tag carrying the inlined bundle (+ bootstrap), or the external fallback. */
export function clientScriptTag(client: string | null): string {
  return client
    ? `<script type="module">${inlineScript(client)}</script>`
    : `<script type="module" src="/client.js"></script>\n<script type="module">${EXTERNAL_BOOTSTRAP}</script>`;
}

/**
 * The static half of the document for streaming SSR: everything up to (and
 * including) the open `<div id="app">`. No route tags - the route's <head>
 * content is applied by the client at boot from the body's head markers.
 */
export function shellOpen(styles: string = getStyles()): string {
  const styleTag = styles ? `\n  <style>${styles}</style>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rose Frame Driver</title>
  <style>${STYLES}</style>${styleTag}
  ${FAVICON}
</head>
<body>
  <div id="app">`;
}

/** Build the document from an explicit client source (edge runtimes have no fs). */
export function buildShell(ssrHtml: string, stateJson: string, client: string | null, head: string[] = [], styles: string = getStyles(), js = true): string {
  const clientTag = clientScriptTag(client);

  const mergedHead = mergeHeadBlocks(head);
  const titleTag = /<title>/i.test(mergedHead) ? '' : '<title>Rose Frame Driver</title>';
  const iconTag = /rel=["']?icon/i.test(mergedHead) ? '' : `\n  ${FAVICON}`;
  const headTags = mergedHead ? `\n  ${mergedHead}` : '';
  const styleTag = styles ? `\n  <style>${styles}</style>` : '';
  const jsTail = js
    ? `\n  <script type="application/json" id="__rosefd_state">${stateJson}</script>\n  ${clientTag}`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${headTags}${iconTag}
  ${titleTag}
  <style>${STYLES}</style>${styleTag}
</head>
<body>
  <div id="app">${ssrHtml}</div>${jsTail}
</body>
</html>`;
}

/** Node entry: reads dist/client.js from disk (mtime-cached). */
export function getHtmlShell(ssrHtml: string, stateJson: string, head: string[] = [], js = true): string {
  return buildShell(ssrHtml, stateJson, getClientSource(), head, getStyles(), js);
}
