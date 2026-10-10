/**
 * oboext build plugin + runtime plugin.
 *
 * Build time (transform):
 *  1. isomorphic preamble in every page/layout component:
 *     - esc(): standard interpolation escape for hand-written calls inside
 *       component scripts (template expressions go through the runtime esc);
 *     - __rvLoad: server -> server loader registry (globalThis, populated by
 *       pages/api/data.rose), browser -> GET /api/data JSON;
 *     - __rvQs: server -> getContext().query, browser -> location.search.
 *  2. relaxed-but-hashed CSP via exported headers; tools/postbuild.mjs swaps
 *     the __RVP_CSP__ sentinel for the build's real inline-script hash.
 *  3. @server/* imports (server-only modules: api routes, middleware-less)
 *     rewritten to absolute source paths; api modules never enter the client
 *     bundle, so pglite/drizzle stay out of the browser.
 *
 * Runtime (onResponse):
 *  4. rosezm 0.2.0 has no @html primitive and runtime esc() cannot be
 *     shadowed. Server raw() mints «RV:n» tokens (see src/server/raw-store.js)
 *     that sit inside the runtime's m-markers; this hook swaps
 *     `<!--m:i-->TOKEN[/m:i]` for the trusted HTML at send time. The marker
 *     leaves with the token, so the client never wires the interpolation.
 *     Routes therefore ship the framework's zero-JS mode (buffered SSR —
 *     streamed documents hand onResponse a bodyless Response); all UI
 *     interactivity is vanilla JS in /public.
 *  5. The zero-JS decision is syntactic and treats the mere presence of a
 *     <form> as "needs the client bundle" (its server-action enhancement).
 *     Our forms are plain tags driven by /public/admin.js (no server
 *     actions), so the tags pass through source as <FORM>: identical DOM in
 *     the HTML parser, invisible to the heuristic, form semantics intact.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { takeRaw } from "./src/server/raw-store.js";

const SERVER_DIR = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "src", "server")
  .replace(/\\/g, "/");

const RAW_MARKER_RE =
  /<!--\u27e6m:(\d+)\u27e7-->\u00abRV:(\d+)\u00bb(?:<!--\u27e6\/m:\1\u27e7-->)?/g;

const PREAMBLE = `
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function __rvQs() {
  return typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : getContext().query || new URLSearchParams();
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

const CSP_HEADERS = `
export const headers = {
  "Content-Security-Policy":
    "script-src 'self' __RVP_CSP__ https://giscus.app https://utteranc.es https://cdn.jsdelivr.net https://*.disqus.com; " +
    "style-src 'unsafe-inline' 'self'; " +
    "img-src 'self' data: https://picsum.photos https://www.gravatar.com https://cn.gravatar.com https://cravatar.cn https://weavatar.com https://seccdn.libravatar.org https://q1.qlogo.cn https://*.disquscdn.com; " +
    "font-src data:; connect-src 'self' https:; frame-src https://giscus.app https://*.disqus.com; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
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
      code = code.replace(/@server\/([a-z-]+)/g, (_, name) => `${SERVER_DIR}/${name}.js`);

      if (isServerOnly(filePath)) return code;

      code = code.replace(/<(\/?)form(?=[\s>])/g, "<$1FORM");

      const m = code.match(SCRIPT_RE);
      if (!m) return code;
      const body = m[1];
      const injected = `${PREAMBLE}\n${CSP_HEADERS}\n${body}`;
      return code.slice(0, m.index) + code.slice(m.index).replace(m[0], `<script>${injected}</script>`);
    },
    async onResponse(_ctx, res) {
      const body = await res.text();
      if (body === "" && res.body === null) return res;
      RAW_MARKER_RE.lastIndex = 0;
      let out = body.replace(RAW_MARKER_RE, (_whole, _mi, id) => {
        const html = takeRaw(Number(id));
        return html === undefined ? "" : html;
      });
      const headers = new Headers(res.headers);
      const looksLikeHtml =
        out !== body || /^\s*(<!doctype html|<html)\b/i.test(body);
      if (looksLikeHtml) {
        headers.set("content-type", "text/html; charset=utf-8");
        out = out.replace(/<style>body\{font-family:system-ui[\s\S]*?<\/style>/, "");
        out = out.replace(/(<body[^>]*>)\s*<div id="app">/, "$1");
        out = out.replace(/<\/div>\s*<\/body>\s*<\/html>\s*$/, "</body>\n</html>");
      }
      return new Response(out, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    },
  },
];
