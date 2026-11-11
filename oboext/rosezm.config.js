/**
 * Oboext build plugin.
 *
 * Build time (transform):
 *  1. isomorphic preamble in every page/layout component:
 *     - esc(): standard interpolation escape for hand-written calls inside
 *       component scripts (template expressions go through the runtime esc);
 *     - __rvLoad: server -> server loader registry (globalThis, populated by
 *       pages/api/data.rose), browser -> GET /api/data JSON. The browser URL
 *       carries the page as BOTH the x-rv-url header and the ?rv= query: the
 *       prod hot cache keys on pathname+query+cookie only (BUG.md AB), so the
 *       page URL must be inside the key or one page's loader fragment is
 *       replayed to another (stale nav highlight, stale chrome context).;
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
 * As of Rosezm 0.2.4 the old runtime hooks are gone: {@html} emits trusted
 * strings natively (P1-2), head <style> passes through (P1-3/head merge),
 * bare <form> no longer pulls the client bundle (P1-3 heuristic), the zero-JS
 * shell ships without #app/demo styles (P1-1), and queries route by pathname
 * (P0-1). No onResponse rewrite of the document is needed anymore.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { apiMsg } from "./api-msg.mjs";

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
        "/api/data?r=" + encodeURIComponent(key) + "&d=" + encodeURIComponent(JSON.stringify(payload || {})) + "&rv=" + encodeURIComponent(window.location.pathname + window.location.search),
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
// contract to the original Oboext, which shipped no CSP at all). Plugin
// code is super-admin trusted, so script-src allows 'unsafe-inline' on the
// public site; the hash-token policy never covered an emitted script anyway
// (every route is csr=false, so the framework ships no inline bundle).
// Admin pages ship the same shape: external /public/*.js plus — on the
// client-JS routes (editors force csr=true; R244's realtime wiring made
// /admin, /admin/dashboard and /admin/comments interactive) — an INLINE
// module bootstrap the framework's build-time hash cannot cover from a
// route-declared header (the pageHeaders merge is last-write-wins per
// HEADER, so a route CSP replaces the framework's hash policy wholesale —
// the old comment claimed the hash policy would "stand" for admin pages
// that omit script-src; measured against dist/headers.json it does not:
// the served admin CSP had no script-src and no default-src, i.e. scripts
// were unrestricted from ANY host). Declaring script-src 'self'
// 'unsafe-inline' explicitly is the honest strictness: external scripts
// only from the app itself, inline only what the build emitted.
const SCRIPT_HOSTS =
  "https://giscus.app https://utteranc.es https://cdn.jsdelivr.net https://*.disqus.com";
const CSP_COMMON =
  "style-src 'unsafe-inline' 'self'; " +
  "img-src 'self' data: https://picsum.photos https://fastly.picsum.photos https://www.gravatar.com https://cn.gravatar.com https://cravatar.cn https://weavatar.com https://seccdn.libravatar.org https://q1.qlogo.cn https://*.disquscdn.com; " +
  "font-src 'self' data:; connect-src 'self' https:; frame-src https://giscus.app https://*.disqus.com; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";
const cspHeadersFor = () => {
  const extra = `  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
`;
  return `export const headers = {
  "Content-Security-Policy":
    "script-src 'self' 'unsafe-inline' ${SCRIPT_HOSTS}; " +
    ${JSON.stringify(CSP_COMMON)},
${extra}};
`;
};

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/i;

function isServerOnly(filePath) {
  const p = filePath.replace(/\\/g, "/");
  return p.includes("/pages/api/") || p.includes("/pages/_middleware.rose");
}

export default [
  {
    name: "oboext",
    // Runtime: API error bodies are written in Chinese at every call site
    // (the strings double as stable ids), so the English rendering happens
    // here at the response edge - one place, no translator threaded through
    // 46 route files. Only non-GET JSON bodies with a top-level `error`
    // string are rewritten; other bodies are replayed byte-for-byte.
    onResponse(ctx, res) {
      try {
        // The full-comment view (?comments=all) duplicates its post: keep it
        // out of the index with the header Google honors, no template churn.
        if ((res.headers.get("content-type") || "").includes("text/html")) {
          const q = new URL(ctx.url, "http://x").searchParams;
          if (q.get("comments") === "all") {
            const h = new Headers(res.headers);
            h.set("x-robots-tag", "noindex, follow");
            return new Response(res.body, { status: res.status, headers: h });
          }
        }
        const m = ctx.method;
        if (m === "GET" || m === "HEAD") return res;
        if (!(res.headers.get("content-type") || "").includes("application/json")) return res;
        return res.text().then((text) => {
          try {
            const j = JSON.parse(text);
            if (j && typeof j === "object" && !Array.isArray(j) && typeof j.error === "string" && j.error) {
              j.error = apiMsg(j.error, ctx);
              return new Response(JSON.stringify(j), {
                status: res.status,
                headers: res.headers,
              });
            }
          } catch {
            /* not a plain error envelope - keep the bytes we just read */
          }
          // res.text() consumed the body; the runtime reads it again to send.
          return new Response(text, { status: res.status, headers: res.headers });
        });
      } catch {
        return res;
      }
    },
    transform(code, filePath) {
      // 3. @server/* -> absolute source path (server-only modules)
      code = code.replace(/@server\/([a-z0-9-]+)/g, (_, name) => `${SERVER_DIR}/${name}.js`);

      if (isServerOnly(filePath)) return code;

      // 1+2. pages / layouts only (admin pages get the strict CSP)
      const m = code.match(SCRIPT_RE);
      if (!m) return code;
      const body = m[1];
      const cspHeaders = cspHeadersFor();
      const injected = `${PREAMBLE}\n${cspHeaders}\n${body}`;
      // Functional replacement, NOT a replacement string: `injected` carries
      // the page's own script verbatim, and a replacement STRING expands
      // `$&`, `$'`, `` $` ``, `$$` and `$n` inside it. One page escaping a
      // regex (`w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` - the standard idiom)
      // then inlined `$&` = the whole matched script block into its own
      // source, and esbuild died on an unterminated string literal. A
      // function receives the matched text literally, so user code may
      // contain any `$` sequence.
      const tail = code.slice(m.index).replace(m[0], () => `<script>${injected}</script>`);
      return code.slice(0, m.index) + tail;
    },
  },
];
