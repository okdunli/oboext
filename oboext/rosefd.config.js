/**
 * oboext build plugin.
 *
 *  1. isomorphic preamble in every page/layout component:
 *     - a raw-aware `esc` shadowing the runtime import inside render():
 *       branded { __rvraw } objects pass through unescaped (server-rendered
 *       HTML), everything else is escaped exactly like the builtin esc();
 *     - __rvLoad: server -> server loader registry (globalThis, populated by
 *       pages/api/data.rose), browser -> GET /api/data JSON;
 *     - __rvQs: server -> getContext().query, browser -> location.search.
 *  2. relaxed-but-hashed CSP via exported headers; tools/postbuild.mjs swaps
 *     the __RVP_CSP__ sentinel for the build's real inline-script hash.
 *  3. @server/* imports (server-only modules: api routes, middleware-less)
 *     rewritten to absolute source paths; api modules never enter the client
 *     bundle, so pglite/drizzle stay out of the browser.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "src", "server")
  .replace(/\\/g, "/");

const PREAMBLE = `
function esc(v) {
  if (v && typeof v === "object" && typeof v.__rvraw === "string") {
    if (!v.__rvok) {
      Object.defineProperty(v, "toString", {
        value: () => (v.__rvhead ? v.__rvraw : ""),
        configurable: true,
      });
      v.__rvok = 1;
    }
    return v.__rvraw;
  }
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
    "script-src 'self' __RVP_CSP__; style-src 'unsafe-inline' 'self'; img-src 'self' data: https://picsum.photos; font-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
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

      const m = code.match(SCRIPT_RE);
      if (!m) return code;
      const body = m[1];
      const injected = `${PREAMBLE}\n${CSP_HEADERS}\n${body}`;
      return code.slice(0, m.index) + code.slice(m.index).replace(m[0], `<script>${injected}</script>`);
    },
  },
];
