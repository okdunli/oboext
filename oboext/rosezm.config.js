/**
 * oboext build plugin.
 *
 * Build time (transform):
 *  1. isomorphic preamble in every page/layout component:
 *     - esc(): standard interpolation escape for hand-written calls inside
 *       component scripts (template expressions go through the runtime esc);
 *     - __rvLoad: server -> server loader registry (globalThis, populated by
 *       pages/api/data.rose), browser -> GET /api/data JSON;
 *     - __rvQs: server -> $query() (per-request query set by setQuery before
 *       each render; reliable under isolated render/ALS), browser -> $query()
 *       (parses location.search). Never read getContext().query: that bag is
 *       shared/replaced by isolateRender and leaks across requests during SSR.
 *  2. CSP via exported headers: public pages allow plugin inline scripts
 *     ('unsafe-inline', original-oboext parity); admin pages stay strict.
 *  3. @server/* imports (server-only modules: api routes, middleware-less)
 *     rewritten to absolute source paths; api modules never enter the client
 *     bundle, so pglite/drizzle stay out of the browser.
 *
 * As of rosezm 0.2.4 the old runtime hooks are gone: {@html} emits trusted
 * strings natively (P1-2), head <style> passes through (P1-3/head merge),
 * bare <form> no longer pulls the client bundle (P1-3 heuristic), the zero-JS
 * shell ships without #app/demo styles (P1-1), and queries route by pathname
 * (P0-1). No onResponse rewrite of the document is needed anymore.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "src", "server")
  .replace(/\\/g, "/");

// NOTE: function declarations, not const arrows. The compiler emits the
// hoisted $data() init block BEFORE the remaining script in render(), and the
// data thunk calls __rvLoad synchronously; only hoisted function declarations
// exist at that point (const arrows would hit the TDZ, server AND client).
const PREAMBLE = `
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
import { $query } from './runtime.js';
function __rvQs() {
  return new URLSearchParams($query());
}
function __rvLoad(key, payload) {
  return typeof window !== "undefined"
    ? fetch(
        "/api/data?r=" + encodeURIComponent(key) + "&d=" + encodeURIComponent(JSON.stringify(payload || {})),
        {
          headers: {
            accept: "application/json",
            "x-rv-url": window.location.pathname + window.location.search,
          },
        }
      ).then((r) => {
        if (!r.ok) throw new Error("load " + key + " failed: " + r.status);
        return r.json();
      })
    : globalThis.__oboeLoaders.dispatch(key, payload, getContext());
}
`;

// Public pages may run plugin code: enabled plugins inject zero-dependency
// inline <script>s through the footer.html/head.tags filters (identical
// contract to the original oboext, which shipped no CSP at all). Plugin
// code is super-admin trusted, so script-src allows 'unsafe-inline' on the
// public site; the hash-token policy never covered an emitted script anyway
// (every route is csr=false, so the framework ships no inline bundle).
// Admin pages ship NO plugin HTML and only external /public/admin.js, so
// they keep the strict policy without 'unsafe-inline'.
const SCRIPT_HOSTS =
  "https://giscus.app https://utteranc.es https://cdn.jsdelivr.net https://*.disqus.com";
const CSP_COMMON =
  "style-src 'unsafe-inline' 'self'; " +
  "img-src 'self' data: https://picsum.photos https://fastly.picsum.photos https://www.gravatar.com https://cn.gravatar.com https://cravatar.cn https://weavatar.com https://seccdn.libravatar.org https://q1.qlogo.cn https://*.disquscdn.com; " +
  "font-src 'self' data:; connect-src 'self' https:; frame-src https://giscus.app https://*.disqus.com; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";
const cspHeadersFor = (admin) => `
export const headers = {
  "Content-Security-Policy":
    "script-src 'self' ${admin ? "" : "'unsafe-inline' "}${SCRIPT_HOSTS}; " +
    ${JSON.stringify(CSP_COMMON)},
};
`;

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/i;

function isServerOnly(filePath) {
  const p = filePath.replace(/\\/g, "/");
  return p.includes("/pages/api/") || p.includes("/pages/_middleware.rose");
}

export default [
  {
    name: "oboext",
    transform(code, filePath) {
      // 3. @server/* -> absolute source path (server-only modules)
      code = code.replace(/@server\/([a-z-]+)/g, (_, name) => `${SERVER_DIR}/${name}.js`);

      if (isServerOnly(filePath)) return code;

      // 1+2. pages / layouts only (admin pages get the strict CSP)
      const m = code.match(SCRIPT_RE);
      if (!m) return code;
      const body = m[1];
      const cspHeaders = cspHeadersFor(filePath.replace(/\\/g, "/").includes("/pages/admin/"));
      const injected = `${PREAMBLE}\n${cspHeaders}\n${body}`;
      return code.slice(0, m.index) + code.slice(m.index).replace(m[0], `<script>${injected}</script>`);
    },
  },
];
