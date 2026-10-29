// Canonical origin resolution (BUG.md AB).
//
// The prod hot cache keys on pathname+query+cookie only, so any byte negotiated
// on a request header is replayed across requests. Absolute URLs (canonical,
// og:url, sitemap <loc>, feed <link>, robots Sitemap:) used to be built straight
// from x-forwarded-host/proto/host: a single spoofed-header request poisoned the
// shared key and every later visitor was served the attacker's origin. The
// framework's own hot refetch compounds it by synthesizing a request with NO
// Host header at all (user-agent only), which rendered http://localhost
// canonicals into every warmed entry after the first TTL refresh.
//
// Policy:
//   1. OBOEXT_SITE_ORIGIN, when set to a valid http(s) URL, wins. It is the one
//      signal an attacker cannot forge and every cluster worker agrees on.
//   2. Otherwise the request's own forwarding headers decide (unchanged
//      behavior), and the first such origin is remembered.
//   3. A request carrying no host signal at all - exactly the synthetic refetch
//      shape - falls back to the remembered origin, never to localhost.

let stickyOrigin = "";

function firstValue(raw: string | null | undefined): string {
  return String(raw ?? "").split(",")[0]?.trim() ?? "";
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
}

/** The configured canonical origin, or "" when unset/invalid. */
export function configuredOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.OBOEXT_SITE_ORIGIN ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin;
  } catch {
    return "";
  }
}

/**
 * The origin every absolute URL must be built from. `headers` is anything with
 * a Headers-like get() (the middleware passes the request's headers; the sitemap
 * passes the same).
 */
export function resolveOrigin(
  headers: { get(name: string): string | null },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = configuredOrigin(env);
  if (configured) return configured;
  const host = firstValue(headers.get("x-forwarded-host")) || firstValue(headers.get("host"));
  if (host) {
    const proto = firstValue(headers.get("x-forwarded-proto"));
    const scheme = proto === "https" || proto === "http" ? proto : isLocalHost(host) ? "http" : "https";
    const origin = `${scheme}://${host}`;
    stickyOrigin = origin;
    return origin;
  }
  // No host signal: the framework's hot-cache refetch synthesizes exactly this
  // shape. Answering localhost here wrote http://localhost canonicals into
  // every warmed entry; the remembered real origin is the truthful answer.
  return stickyOrigin || "http://localhost";
}

/** Test seam: forget the remembered origin. */
export function resetStickyOrigin(): void {
  stickyOrigin = "";
}

/**
 * Host of this site, for classifying a referrer as "internal" (0041).
 *
 * Uses the same two signals resolveOrigin does, in the same order: the
 * configured origin when set, else the remembered request origin. It
 * deliberately does NOT re-read request headers - a per-request host would make
 * the classification depend on which header a proxy happened to forward, and
 * "is this referrer us?" is a property of the site, not of the request.
 *
 * "" when nothing is known yet (a cold process before its first request, or a
 * test): callers treat that as "cannot tell", never as "no site".
 */
export function ownHost(): string {
  const origin = configuredOrigin() || stickyOrigin;
  if (!origin) return "";
  try {
    return new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
