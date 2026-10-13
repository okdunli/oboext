/**
 * Serve /plugin-assets/<slug>/<rel...> from plugins/<slug>/<rel...> on disk —
 * a plugin's admin-panel script and other self-contained static files
 * (parallel to /theme-assets/). GET/HEAD only; a crafted path that escapes
 * the plugins root is rejected (403/404).
 *
 * Why a file and not an inline <script>: the admin document carries a strict
 * CSP (script-src 'self'), so a plugin's behaviour must ship as an external
 * script exactly like the core /public/admin.js does.
 */
import fs from "fs";
import path from "path";
import { PLUGINS_DIR } from "./plugin-registry.js";
import { mimeFor } from "./storage.js";

export function servePluginAsset(urlPath: string, method = "GET"): Response {
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
    const rel = decodeURIComponent(urlPath.replace(/^\/plugin-assets\//, ""));
    const segments = rel.split("/").filter(Boolean);
    if (segments.length < 2) return notFound();
    const pluginsRoot = path.resolve(PLUGINS_DIR);
    const target = path.resolve(pluginsRoot, ...segments);
    if (!target.startsWith(pluginsRoot + path.sep)) return forbidden();
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
