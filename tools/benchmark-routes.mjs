#!/usr/bin/env node
// Route latency benchmark against a RUNNING preview server (node tools/serve.mjs preview).
//
// Measures what a visitor actually pays:
//   warm — the steady state (render cache / memo hits)
//   cold — the first render after a content write invalidates every cache,
//          i.e. what the next visitor after you press "publish" pays
// A route whose cold number drifts far above the pack is a render-path
// regression; this script is how that gets noticed before a user does.
//
// Usage: node tools/benchmark-routes.mjs [origin]  (default http://127.0.0.1:3000)

const ORIGIN = process.argv[2] || "http://127.0.0.1:3000";
const WARM_N = 7;
const COOKIE = process.env.BENCH_COOKIE || ""; // "cms_session=…; cms_csrf=…" to measure admin routes
// The app's CSRF gate answers 400 to any cookie-bearing request that omits the
// token header, so the cold-pass write must echo cms_csrf back as x-csrf-token.
const CSRF = /(?:^|;\s*)cms_csrf=([^;]+)/.exec(COOKIE)?.[1] || "";

const ROUTES = [
  "/",
  "/blog",
  "/en/blog",
  "/pages/about",
  "/en/pages/english-smoke",
  "/archives",
  "/en/archives",
  "/newsletter",
  "/search?q=hello",
  "/sitemap.xml",
  "/feed.xml",
  "/api/search-suggest?q=hello",
];

// The admin screens are where the site owner lives, and they only answer a
// session - without the cookie they 302 to /admin/login and the number would
// measure the redirect, not the screen. Added only when BENCH_COOKIE is set.
if (COOKIE) {
  ROUTES.push(
    "/admin",
    "/admin/posts",
    "/admin/pages",
    "/admin/comments",
    "/admin/media",
    "/admin/members",
    "/admin/settings",
    "/admin/themes",
  );
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    min: s[0],
    med: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)],
  };
};
// performance.now() already answers milliseconds; a curl-style seconds value
// fed here would print a 1000x lie, so no conversion — just formatting.
const ms = (v) => v.toFixed(1).padStart(7) + "ms";

async function hit(path, cold) {
  const t0 = performance.now();
  const res = await fetch(ORIGIN + path, {
    headers: cold ? { "cache-control": "no-cache" } : {},
    ...(COOKIE ? { headers: { ...(cold ? { "cache-control": "no-cache" } : {}), cookie: COOKIE } } : {}),
  });
  await res.arrayBuffer();
  return { ms: performance.now() - t0, code: res.status };
}

// A content write is what invalidates the render caches in production; the
// admin settings PATCH is the cheapest such write. Without a session cookie
// the cold pass measures warm numbers instead — say so rather than lie.
let canCold = false;
if (COOKIE) {
  const res = await fetch(ORIGIN + "/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: COOKIE, ...(CSRF ? { "x-csrf-token": CSRF } : {}) },
    body: JSON.stringify({}),
  });
  canCold = res.ok;
}

console.log(`route latency against ${ORIGIN}${canCold ? " (warm + cold)" : " (warm only — set BENCH_COOKIE for the cold pass)"}`);
console.log("route".padEnd(34) + "warm min/med/p95          cold first");

let bad = 0;
for (const route of ROUTES) {
  await hit(route);
  const warm = [];
  for (let i = 0; i < WARM_N; i++) warm.push((await hit(route)).ms);
  const w = stats(warm);
  let coldCell = "    —";
  if (canCold) {
    // One write invalidates everything; the next hit of THIS route is its cold render.
    const inv = await fetch(ORIGIN + "/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: COOKIE, ...(CSRF ? { "x-csrf-token": CSRF } : {}) },
      body: JSON.stringify({}),
    });
    if (inv.ok) {
      const c = await hit(route);
      coldCell = ms(c.ms);
      if (c.code !== 200) bad++;
    } else {
      canCold = false;
    }
  }
  const probe = await hit(route);
  if (probe.code !== 200 && probe.code !== 304) bad++;
  console.log(
    route.padEnd(34) +
      [w.min, w.med, w.p95].map(ms).join("/") +
      "   " +
      coldCell,
  );
}

console.log(bad ? `\n${bad} route probe(s) answered non-200 — investigate before trusting the numbers.` : "\nall routes answered 200.");
