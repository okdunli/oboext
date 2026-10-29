// Webmention (W3C REC) — the receive endpoint and the send side.
//
// Two hard framework rules shape everything here (both are the same rule seen
// from two ends): an api endpoint answers immediately and never holds the
// connection, and every outbound HTTP fetch is fire-and-forget. A webmention
// receiver is by definition a fetch-the-source-verify-and-store protocol, so
// the endpoint's answer (202, empty body) is a receipt, not a result: the row
// is CLAIMED synchronously (the UNIQUE(source, target) insert is the receipt)
// and all network work runs behind `void (async () => …)()` — the same shape
// as plugins/comment-mail-notify/index.ts:44-51.
//
// The send side runs off the post.published action: scan the new post body's
// <a href> targets, discover each one's endpoint (Link: header or
// <link rel="webmention">), POST source/target. Bounded twice on purpose — at
// most MAX_LINKS_PER_POST links, and SEND_BUDGET_MS of wall clock for the whole
// batch — so a page that publishes a post full of dead links cannot leave a
// background task (or a socket) behind.
import { addAction, addFilter, HOOKS } from "./hooks.js";
import { rawQuery, ensureMigrations } from "./db.js";
import { createPublicComment } from "./admin.js";
import { getPermalinkConfig, postUrlFor, resolveSitePath } from "./links.js";
import { splitLocalePath } from "./i18n.js";
import { resolveOrigin } from "./site-origin.js";
import { createLogger } from "./logger.js";

const log = createLogger("webmention");

/** The bare path the discovery <link> advertises (W3C: endpoint URL, any path). */
export const WEBMENTION_PATH = "/webmention";

/** Wall-clock budget for one outbound batch; the rest are abandoned. */
export const SEND_BUDGET_MS = 15_000;
/** Per-request fetch cap; the receiver's spec suggestion is 30s, 10s is enough. */
export const FETCH_TIMEOUT_MS = 10_000;
/** At most this many external links are notified per post. */
export const MAX_LINKS_PER_POST = 10;
/** Hard cap on a source document; a mention page is a page, not a download. */
export const MAX_HTML_BYTES = 512 * 1024;
/** createPublicComment's own ceiling (admin.ts) — sliced here, not thrown. */
const MAX_CONTENT = 5000;

// --------------------------------------------------------------- SSRF guard
//
// A receiver fetches a URL a stranger chose, from inside the server's network
// namespace: the classic SSRF shape. The blocklist below is deliberately
// literal (host string, no DNS) — it is the first of two layers, the second
// being `safeFetch`'s per-hop re-validation of every redirect target, so a
// 302 cannot walk the request into 127.0.0.1 after the first URL passed.
// shortcut: DNS rebinding (a public name that resolves to 169.254.169.254) is
// not covered; closing it needs a resolve-then-pin-IP fetch, which Node's
// undici does not expose portably. The 10s cap plus fire-and-forget bounds the
// damage to one abandoned request.

/** IPv4 ranges that must never be fetched (private, loopback, link-local). */
const IPV4_BLOCKS: Array<[string, number]> = [
  // [network, prefix length]
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal"];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function inV4(ip: string, net: string, bits: number): boolean {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(net);
  if (a == null || b == null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

// IPv6 is resolved to its 16 bytes and judged by prefix, not by string
// matching. The URL parser hands the host back in ONE canonical form
// (`[::ffff:7f00:1]` for what the caller wrote as `::ffff:127.0.0.1`), so a
// textual rule against the written form silently misses the loopback alias —
// and `fd00::1`'s first group is "", not "fd". Parsing removes both traps.
const V6_BLOCKS: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link local
  ["::ffff:0:0", 96], // IPv4-mapped: every blocked v4 lands here too
];

/** 16 bytes of an IPv6 literal, or null when it does not parse. */
function ipv6ToBytes(raw: string): Uint8Array | null {
  let h = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return null;
  // A trailing dotted quad (::ffff:127.0.0.1) is two groups of hex.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1]);
    if (v4 == null) return null;
    const hi = Math.floor(v4 / 65536).toString(16);
    const lo = (v4 % 65536).toString(16);
    h = h.slice(0, dotted.index) + hi + ":" + lo;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const explicit = head.length + (tail?.length ?? 0);
  if (tail === null && explicit !== 8) return null;
  if (tail !== null && explicit > 8) return null;
  const groups = tail === null ? head : [...head, ...Array(8 - explicit).fill("0"), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (g == null || !/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function inV6(bytes: Uint8Array, net: string, bits: number): boolean {
  const base = ipv6ToBytes(net);
  if (!base) return false;
  for (let i = 0; i < 16; i++) {
    const left = bits - i * 8;
    if (left <= 0) break;
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((bytes[i]! & mask) !== (base[i]! & mask)) return false;
  }
  return true;
}

function isBlockedIpv4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return IPV4_BLOCKS.some(([net, bits]) => inV4(host, net, bits));
}

function isBlockedIpv6(host: string): boolean {
  const bytes = ipv6ToBytes(host);
  if (!bytes) return false;
  // A v4-mapped literal must answer for the v4 it wraps: ::ffff:7f00:1 IS
  // 127.0.0.1, and the only thing the mapping changes is the spelling.
  const v4Mapped = inV6(bytes, "::ffff:0:0", 96);
  if (v4Mapped) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isBlockedIpv4(v4) || V6_BLOCKS.some(([net, bits]) => inV6(bytes, net, bits));
  }
  return V6_BLOCKS.some(([net, bits]) => inV6(bytes, net, bits));
}

/**
 * Is this hostname in the SSRF blocklist? Exported because it is the rule the
 * whole receiver stands on, and a lock must be testable without a network.
 */
export function isBlockedHost(rawHost: string): boolean {
  const host = String(rawHost ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost") return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) return true;
  if (host.includes(":")) return isBlockedIpv6(host);
  if (isBlockedIpv4(host)) return true;
  return false;
}

/** Ports a webmention fetch may use. Anything else is a service, not a site. */
const ALLOWED_PORTS = new Set(["", "80", "443"]);

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Validate an untrusted webmention URL: absolute http(s), a public host, and a
 * web port. Every rejection reason is a short ASCII token (this is a machine
 * protocol, not a UI surface).
 *
 * `allowPrivateHosts` is the TEST HARNESS seam only — the route, the
 * middleware and the sender's hook never set it. It relaxes the host blocklist
 * AND the port allowlist together, because a local fixture server necessarily
 * listens on a private address and an ephemeral port; relaxing one without the
 * other would be a half-open door with no test behind it.
 */
export function inspectWebmentionUrl(
  raw: unknown,
  opts: { allowPrivateHosts?: boolean } = {},
): UrlVerdict {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: false, reason: "missing_url" };
  if (s.length > 2000) return { ok: false, reason: "url_too_long" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "not_absolute_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme" };
  }
  if (!u.hostname) return { ok: false, reason: "missing_host" };
  if (opts.allowPrivateHosts) return { ok: true, url: u };
  if (!ALLOWED_PORTS.has(u.port)) return { ok: false, reason: "port_not_allowed" };
  if (isBlockedHost(u.hostname)) return { ok: false, reason: "private_address" };
  return { ok: true, url: u };
}

/**
 * The TARGET is judged by shape only — absolute http(s), some host.
 *
 * Why not the full blocklist: a target is never fetched. We take its PATH and
 * resolve it against our own permalink config, so a target naming
 * 127.0.0.1:3000 costs nothing an attacker could exploit (they learn only
 * whether a post with that path exists, which the public site already says).
 * Applying the private-address rule here instead breaks the ordinary
 * self-hosted deployment: a blog on 192.168.1.x:8080 behind a proxy is told
 * its own canonical URL is forbidden. The SSRF surface is the SOURCE and the
 * discovered ENDPOINT, and both go through inspectWebmentionUrl.
 */
export function inspectTargetUrl(raw: unknown): UrlVerdict {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: false, reason: "missing_url" };
  if (s.length > 2000) return { ok: false, reason: "url_too_long" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "not_absolute_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme" };
  }
  if (!u.hostname) return { ok: false, reason: "missing_host" };
  return { ok: true, url: u };
}

/** Fragment-free, slash-normalized form used for every URL comparison. */
export function normalizeUrlForCompare(u: URL): string {
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

// ------------------------------------------------------------ HTML plumbing
//
// No DOM and no parser dependency: the two facts a webmention needs from a
// page (does it link to the target, what does its h-entry say) are extractable
// with a tolerant tag scanner. A malformed page must produce "no link found",
// never a throw.

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // <head> is metadata, not prose. Its <title> is already read on its own;
    // letting it also reach the visible-text fallback would make a pageless
    // source quote its own headline twice.
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
    const key = name.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    if (key.startsWith("#x")) {
      const n = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    if (key.startsWith("#")) {
      const n = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/** Visible text of a fragment: tags dropped, entities decoded, space folded. */
export function htmlToText(html: string): string {
  return decodeEntities(
    stripNonContent(html)
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function classTokens(attrs: string): string[] {
  const m = /\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const raw = m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * Inner HTML of the FIRST element carrying `cls`, or null. Balanced by counting
 * same-name opens/closes when the tag is not void, so a nested <div> inside the
 * h-entry does not cut the slice short (which would silently lose the e-content).
 */
function innerOfFirstClass(html: string, cls: string): string | null {
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (!classTokens(m[2] || "").includes(cls)) continue;
    const tag = m[1].toLowerCase();
    const start = m.index + m[0].length;
    if (VOID_TAGS.has(tag) || m[0].endsWith("/>")) return "";
    const openRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    openRe.lastIndex = start;
    let depth = 1;
    let om: RegExpExecArray | null;
    while ((om = openRe.exec(html))) {
      if (om[1] === "/") {
        depth--;
        if (depth === 0) return html.slice(start, om.index);
      } else if (!om[0].endsWith("/>")) {
        depth++;
      }
    }
    return html.slice(start);
  }
  return null;
}

export type ParsedEntry = {
  /** h-entry p-name, or "" */
  name: string;
  /** h-entry e-content, or "" */
  content: string;
  /** document <title>, or "" */
  title: string;
  /** visible text of the whole document, capped */
  text: string;
};

/** Tolerant h-entry read. Missing microformats are a normal answer, not an error. */
export function parseEntry(html: string): ParsedEntry {
  const scoped = innerOfFirstClass(html, "h-entry");
  const body = scoped ?? html;
  const name = innerOfFirstClass(body, "p-name");
  const content = innerOfFirstClass(body, "e-content");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return {
    name: name ? htmlToText(name) : "",
    content: content ? htmlToText(content) : "",
    title: titleMatch ? htmlToText(titleMatch[1]) : "",
    text: htmlToText(html).slice(0, 300),
  };
}

/** Every absolute-ish href in the document, resolved against `base`. */
export function extractAnchors(html: string, base: URL): string[] {
  const out: string[] = [];
  const re = /<a\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1] || "");
    if (!href) continue;
    const raw = decodeEntities(href[2] ?? href[3] ?? href[4] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;
    try {
      const abs = new URL(raw, base);
      if (abs.protocol === "http:" || abs.protocol === "https:") out.push(abs.href);
    } catch {
      /* an unparseable href proves nothing about the target */
    }
  }
  return out;
}

/** Does the source document link to `target`? Fragment-insensitive. */
export function linksTo(html: string, base: URL, target: URL): boolean {
  const want = normalizeUrlForCompare(target);
  return extractAnchors(html, base).some((href) => {
    try {
      return normalizeUrlForCompare(new URL(href)) === want;
    } catch {
      return false;
    }
  });
}

// ------------------------------------------------------- endpoint discovery

export type LinkHeaderEntry = { url: string; rels: string[] };

/**
 * Parse an RFC 8288 Link header. Comma-splitting alone is wrong (a URL may
 * contain a comma) so the split is driven by the `<...>` brackets.
 */
export function parseLinkHeader(raw: string | null | undefined): LinkHeaderEntry[] {
  const header = String(raw ?? "");
  const out: LinkHeaderEntry[] = [];
  const re = /<([^>]*)>([^,<]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) {
    const url = m[1].trim();
    if (!url) continue;
    const rel = /\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s;,]+))/i.exec(m[2] || "");
    const rels = (rel ? (rel[2] ?? rel[3] ?? rel[4] ?? "") : "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    out.push({ url, rels });
  }
  return out;
}

/** `<link rel="webmention" href="…">` endpoints, in document order. */
export function endpointsFromHtml(html: string, base: URL): string[] {
  const out: string[] = [];
  const re = /<link\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    const rel = /\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const rels = (rel ? (rel[2] ?? rel[3] ?? rel[4] ?? "") : "").toLowerCase().split(/\s+/);
    if (!rels.includes("webmention")) continue;
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!href) continue;
    const raw = decodeEntities(href[2] ?? href[3] ?? href[4] ?? "").trim();
    if (!raw) continue;
    try {
      out.push(new URL(raw, base).href);
    } catch {
      /* a broken endpoint attribute is not a candidate */
    }
  }
  return out;
}

/** Both discovery channels, header first (it is the cheaper read). */
export function discoverEndpoints(
  html: string,
  base: URL,
  linkHeader: string | null | undefined,
): string[] {
  const fromHeader = parseLinkHeader(linkHeader)
    .filter((e) => e.rels.includes("webmention"))
    .map((e) => {
      try {
        return new URL(e.url, base).href;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  const all = [...fromHeader, ...endpointsFromHtml(html, base)];
  return [...new Set(all)];
}

// --------------------------------------------------------------- safe fetch

class BlockedUrl extends Error {}

type FetchOpts = {
  allowPrivateHosts?: boolean;
  timeoutMs: number;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
};

/**
 * Fetch with the SSRF guard applied to EVERY hop. `redirect: "manual"` is the
 * point: the platform's own redirect following would replay the request at a
 * Location the guard never saw.
 */
async function safeFetch(rawUrl: string, opts: FetchOpts): Promise<{ res: Response; url: URL }> {
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const verdict = inspectWebmentionUrl(current, { allowPrivateHosts: opts.allowPrivateHosts });
    if (!verdict.ok) throw new BlockedUrl(verdict.reason);
    const res = await fetch(verdict.url.href, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, opts.timeoutMs)),
      cache: "no-store",
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { res, url: verdict.url };
      try {
        current = new URL(loc, verdict.url).href;
      } catch {
        throw new BlockedUrl("bad_redirect");
      }
      continue;
    }
    return { res, url: verdict.url };
  }
  throw new BlockedUrl("too_many_redirects");
}

/** Read at most `max` bytes of a response body as text. */
async function readCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - max))));
        break;
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the cap already closed the stream */
    }
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function isHtmlResponse(res: Response): boolean {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return !ct || ct.includes("html") || ct.includes("text/plain");
}

// ------------------------------------------------------------- receive side

export type ReceiveResult =
  | { ok: true; status: 202; claimed: boolean }
  | { ok: false; status: 400 | 405 | 413 | 429; reason: string };

const MAX_BODY_BYTES = 8192;

/** Per-IP receive budget (per process, like every other memo in this app). */
const RECEIVE_WINDOW_MS = 60_000;
const RECEIVE_MAX = Math.max(1, Number(process.env.OBOEXT_WEBMENTION_RATE_MAX) || 30);
const receiveHits = new Map<string, number[]>();

/** Concurrency cap for background verifications (each holds a socket). */
const MAX_ACTIVE = 4;
let activeJobs = 0;

/** Test seam / warm-up: drop the rate-limit window and the in-flight counter. */
export function resetReceiveState(): void {
  receiveHits.clear();
  activeJobs = 0;
}

export function allowReceive(ip: string): boolean {
  // No address (a bare unit-test Request, a proxy without forwarding headers)
  // is not rate-limited: an empty key would put every anonymous caller in one
  // bucket and lock the endpoint out of its own test harness.
  if (!ip) return true;
  const now = Date.now();
  const hits = (receiveHits.get(ip) ?? []).filter((t) => now - t < RECEIVE_WINDOW_MS);
  if (hits.length >= RECEIVE_MAX) {
    receiveHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  receiveHits.set(ip, hits);
  // Bound the map itself: keys older than the window are dropped on every call.
  if (receiveHits.size > 512) {
    for (const [k, v] of receiveHits) {
      if (!v.length || now - v[v.length - 1]! >= RECEIVE_WINDOW_MS) receiveHits.delete(k);
    }
  }
  return true;
}

async function readMentionBody(request: Request): Promise<Record<string, string> | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const ct = (request.headers.get("content-type") || "").toLowerCase();

  // The three shapes a sender can reach us in. `multipart/form-data` is not a
  // webmention wire format — it appears because the dev server hands the
  // middleware an already-parsed FormData (toWebRequest wraps it in a Request),
  // so the browser-facing form encoding arrives as multipart there while a
  // real sender posts urlencoded. Accepting both keeps the endpoint honest on
  // every host instead of only on the prod path.
  if (ct.includes("multipart/form-data")) {
    try {
      const fd = await request.formData();
      const get = (k: string) => {
        const v = fd.get(k);
        return typeof v === "string" ? v : "";
      };
      return { source: get("source"), target: get("target") };
    } catch {
      return null;
    }
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_BYTES) return null;
  if (ct.includes("json")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return {
        source: typeof parsed.source === "string" ? parsed.source : "",
        target: typeof parsed.target === "string" ? parsed.target : "",
      };
    } catch {
      return null;
    }
  }

  // The dev server's toWebRequest() assigns an already-parsed FormData as the
  // Request body while FORWARDING the sender's original content-type header.
  // undici then serializes that FormData as multipart and leaves the header
  // saying application/x-www-form-urlencoded — so the bytes below the header
  // can be either shape. Sniff the body, not only the header, or the endpoint
  // silently reads empty fields on the dev host.
  if (/^\s*--/.test(text) && /\r?\n(content-disposition|--)/i.test(text)) {
    const fields: Record<string, string> = {};
    const re = /name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n--/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) fields[m[1]!] = m[2]!;
    return { source: fields.source ?? "", target: fields.target ?? "" };
  }

  const params = new URLSearchParams(text);
  return { source: params.get("source") ?? "", target: params.get("target") ?? "" };
}

function textResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/** Claim the (source, target) pair. False when it was already claimed. */
async function claimMention(source: string, target: string): Promise<number | null> {
  const rows = await rawQuery<{ id: number }>(
    `insert into webmentions (source, target) values ($1, $2)
     on conflict (source, target) do nothing
     returning id`,
    [source, target],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function finishMention(
  id: number,
  status: "accepted" | "rejected",
  postId: number | null,
  commentId: number | null,
): Promise<void> {
  await rawQuery(
    `update webmentions
        set status = $2,
            post_id = coalesce($3, post_id),
            comment_id = coalesce($4, comment_id)
      where id = $1`,
    [id, status, postId, commentId],
  );
}

/**
 * The HTTP entry point for POST /webmention (and the /api/webmention alias).
 *
 * Answers before any network work: the URL shape is checked (cheap), the row is
 * claimed (one insert), the verification is scheduled, 202. `opts` exists for
 * the test harness only — the route and the middleware never pass it, so the
 * SSRF blocklist is always on in production.
 */
export async function handleReceiveRequest(
  request: Request,
  opts: { allowPrivateHosts?: boolean } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    if (request.method === "GET" || request.method === "HEAD") {
      return textResponse(200, "Webmention endpoint. POST source and target.");
    }
    return textResponse(405, "method not allowed", { allow: "GET, POST" });
  }
  try {
    await ensureMigrations();
  } catch (e) {
    log.error("[webmention] migrations unavailable:", e);
    return textResponse(503, "database unavailable");
  }

  const body = await readMentionBody(request);
  if (!body) return textResponse(413, "payload_too_large_or_malformed");

  const source = inspectWebmentionUrl(body.source, opts);
  if (!source.ok) return textResponse(400, `invalid source: ${source.reason}`);
  // Shape-only: the target is never fetched, only path-resolved (see
  // inspectTargetUrl). The full blocklist belongs on the source and on the
  // endpoint we are told to POST to — those are the requests we make.
  const target = inspectTargetUrl(body.target);
  if (!target.ok) return textResponse(400, `invalid target: ${target.reason}`);
  if (normalizeUrlForCompare(source.url) === normalizeUrlForCompare(target.url)) {
    return textResponse(400, "source and target are the same URL");
  }

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0]!.trim() ||
    (request.headers.get("x-real-ip") || "").trim();
  if (!allowReceive(ip)) return textResponse(429, "too many webmentions; retry later");

  let id: number | null = null;
  try {
    id = await claimMention(source.url.href, target.url.href);
  } catch (e) {
    log.error("[webmention] claim failed:", e);
    return textResponse(503, "database unavailable");
  }
  // Already known: a re-delivery is a receipt, not an error. No second comment,
  // no second fetch — UNIQUE(source, target) is the whole idempotency story.
  if (id == null) return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });

  queueVerification({ id, source: source.url.href, target: target.url.href, ...opts });
  return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
}

/** Schedule the background verification (never awaited by the request). */
function queueVerification(job: {
  id: number;
  source: string;
  target: string;
  allowPrivateHosts?: boolean;
}): void {
  if (activeJobs >= MAX_ACTIVE) {
    // Backpressure, not a queue: an unbounded in-memory backlog is a memory
    // leak with extra steps. Shedding a mention costs nothing (it can be
    // re-sent), holding 10 000 sockets costs the process.
    void finishMention(job.id, "rejected", null, null).catch(() => {});
    log.warn("[webmention] shed " + job.source + " (too many verifications in flight)");
    return;
  }
  activeJobs++;
  void (async () => {
    try {
      await processWebmention(job);
    } catch (e) {
      log.warn("[webmention] verification failed:", e instanceof Error ? e.message : e);
    } finally {
      activeJobs--;
    }
  })();
}

export type ProcessInput = {
  id: number;
  source: string;
  target: string;
  allowPrivateHosts?: boolean;
};

export type ProcessOutcome =
  | { status: "accepted"; commentId: number; postId: number }
  | { status: "rejected"; reason: string };

/**
 * Verify one claimed mention and land its comment. Exported so the harness can
 * drive it without an HTTP round trip; the endpoint calls it through
 * queueVerification, which is the only production caller.
 */
export async function processWebmention(input: ProcessInput): Promise<ProcessOutcome> {
  const reject = async (reason: string): Promise<ProcessOutcome> => {
    await finishMention(input.id, "rejected", null, null);
    log.warn("[webmention] rejected " + input.source + " -> " + input.target + ": " + reason);
    return { status: "rejected", reason };
  };

  let sourceUrl: URL;
  let targetUrl: URL;
  try {
    sourceUrl = new URL(input.source);
    targetUrl = new URL(input.target);
  } catch {
    return reject("malformed_url");
  }

  // 1. Resolve the target to one of our published posts. The path is what
  //    matters: a target may arrive with any host (a mention is usually sent to
  //    the canonical URL, but self-hosted aliases exist) and we only ever write
  //    to OUR post id.
  const { path } = splitLocalePath(targetUrl.pathname);
  const segments = path.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  let resolved: Awaited<ReturnType<typeof resolveSitePath>> = null;
  try {
    resolved = segments.length ? await resolveSitePath(segments) : null;
  } catch (e) {
    return reject("target_lookup_failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (!resolved || resolved.kind !== "post") return reject("target_not_a_post");
  const postId = resolved.post.post.id;

  // 2. Fetch the source and prove it links here.
  let html: string;
  let baseUrl: URL;
  try {
    const { res, url } = await safeFetch(input.source, {
      allowPrivateHosts: input.allowPrivateHosts,
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Oboext-Webmention/1.0 (+webmention receiver)",
      },
    });
    baseUrl = url;
    if (!res.ok) return reject("source_status_" + res.status);
    if (!isHtmlResponse(res)) return reject("source_not_html");
    html = await readCapped(res, MAX_HTML_BYTES);
  } catch (e) {
    if (e instanceof BlockedUrl) return reject("source_blocked: " + e.message);
    return reject("source_fetch_failed: " + (e instanceof Error ? e.name : String(e)));
  }
  if (!linksTo(html, baseUrl, targetUrl)) return reject("source_does_not_link_target");

  // 3. Build the comment out of the source's h-entry.
  const entry = parseEntry(html);
  // Name: h-entry p-name, then the document <title>, then the source host.
  // Content: e-content, then p-name, then the visible text (which the <title>
  // already contributed to when there was one) — the task's fallback ladder.
  const authorName =
    (entry.name || entry.title || sourceUrl.hostname).trim().slice(0, 64) || sourceUrl.hostname;
  const content =
    (entry.content || entry.name || entry.title || entry.text || "").trim().slice(0, MAX_CONTENT) ||
    "(webmention)";

  let commentId: number;
  try {
    const out = await createPublicComment({
      postId,
      postType: "webmention",
      authorName,
      authorUrl: sourceUrl.href,
      content,
      ip: null,
      siteHost: null,
      // A webmention is scraped, not asserted: the identity fields come from
      // the source page's own markup, there is nobody to prompt for an email,
      // and the verdict is always pending (a human moderates). Without the
      // flag, `requireNameEmail` would reject every mention on a site that
      // turned the comment-form requirement on.
      viaWebmention: true,
    });
    commentId = out.comment.id;
  } catch (e) {
    // Comments turned off, post closed, blocklist: a legitimate refusal, but
    // not an accepted mention.
    return reject("comment_refused: " + (e instanceof Error ? e.message : String(e)));
  }

  await finishMention(input.id, "accepted", postId, commentId);
  log.info(`[webmention] accepted ${input.source} -> post ${postId} (comment ${commentId})`);
  return { status: "accepted", commentId, postId };
}

// ---------------------------------------------------------------- send side

/**
 * Every external <a href> in a post's stored body. Links live in `html` blocks
 * (the block model stores paragraph text as plain text, so an anchor can only
 * come from a raw-HTML block); the origin's own host is excluded so an internal
 * link never becomes a mention of ourselves.
 */
export function externalLinksFromBlocks(content: unknown, origin: string): string[] {
  const blocks = Array.isArray(content) ? content : [];
  let ownHost = "";
  try {
    ownHost = new URL(origin).host.toLowerCase();
  } catch {
    /* an unusable origin means every link counts as external */
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const rec = b as { type?: string; html?: string };
    if (rec.type !== "html" || typeof rec.html !== "string") continue;
    for (const href of extractAnchors(rec.html, new URL(origin || "http://localhost"))) {
      let u: URL;
      try {
        u = new URL(href);
      } catch {
        continue;
      }
      if (ownHost && u.host.toLowerCase() === ownHost) continue;
      const key = normalizeUrlForCompare(u);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= MAX_LINKS_PER_POST) return out;
    }
  }
  return out;
}

export type PostPublishedPayload = {
  post?: {
    id?: number;
    slug?: string;
    pinyinSlug?: string | null;
    initialSlug?: string | null;
    title?: string | null;
    content?: unknown;
    publishedAt?: Date | string | null;
    createdAt?: Date | string | null;
  } | null;
};

/**
 * Tell every external page a freshly published post links to. Fire-and-forget:
 * `void (async () => …)()`, every failure a warn — a publish must never wait on
 * a stranger's server, and a dead endpoint must not fail the save.
 */
export function sendWebmentionsForPost(payload: PostPublishedPayload): void {
  const post = payload?.post;
  if (!post || typeof post.id !== "number") return;
  // Hoisted: the typeof narrowing above does not survive into the closure.
  const postId: number = post.id;
  void (async () => {
    try {
      // No request context here: the configured origin wins, otherwise the one
      // the last real request remembered. A localhost answer means we do not
      // know our own public URL — sending `http://localhost/...` as a source
      // would be a lie every receiver would reject, so we stay quiet.
      const origin = resolveOrigin({ get: () => "" });
      if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(origin)) {
        log.debug("[webmention] no public origin known; skipping outbound mentions");
        return;
      }
      const cfg = await getPermalinkConfig();
      const source = origin.replace(/\/+$/, "") + postUrlFor(cfg, {
        id: postId,
        slug: post.slug ?? String(postId),
        pinyinSlug: post.pinyinSlug ?? null,
        initialSlug: post.initialSlug ?? null,
        title: post.title ?? null,
        publishedAt: post.publishedAt ?? null,
        createdAt: post.createdAt ?? null,
      });
      const targets = externalLinksFromBlocks(post.content, origin);
      if (!targets.length) return;
      await sendToAll(source, targets);
      log.info(`[webmention] outbound for post ${postId} finished over ${targets.length} link(s)`);
    } catch (e) {
      log.warn("[webmention] outbound failed:", e instanceof Error ? e.message : e);
    }
  })();
}

/**
 * The bounded notify loop, split out so the harness can drive it with its own
 * deadline and endpoint rules. At most MAX_LINKS_PER_POST targets (enforced by
 * externalLinksFromBlocks) and at most SEND_BUDGET_MS of wall clock: once the
 * budget is gone the remaining links are abandoned, because a background task
 * that outlives its publish is a socket nobody is waiting on.
 */
export async function sendToAll(
  source: string,
  targets: string[],
  opts: { deadlineMs?: number; allowPrivateHosts?: boolean } = {},
): Promise<{ sent: number; attempted: number }> {
  const deadline = Date.now() + (opts.deadlineMs ?? SEND_BUDGET_MS);
  let sent = 0;
  let attempted = 0;
  for (const target of targets.slice(0, MAX_LINKS_PER_POST)) {
    const left = deadline - Date.now();
    if (left <= 0) {
      log.warn(`[webmention] budget exhausted after ${sent} of ${targets.length} links; abandoning the rest`);
      break;
    }
    attempted++;
    if (await sendOneMention(source, target, left, opts.allowPrivateHosts)) sent++;
  }
  return { sent, attempted };
}

/** Discover one target's endpoint and POST the mention. Never throws. */
async function sendOneMention(
  source: string,
  target: string,
  budgetMs: number,
  allowPrivateHosts?: boolean,
): Promise<boolean> {
  const targetUrl = inspectWebmentionUrl(target, { allowPrivateHosts });
  if (!targetUrl.ok) {
    log.debug(`[webmention] skip ${target}: ${targetUrl.reason}`);
    return false;
  }
  const step = Math.min(FETCH_TIMEOUT_MS, budgetMs);
  let html = "";
  let linkHeader: string | null = null;
  let base = targetUrl.url;
  try {
    const { res, url } = await safeFetch(target, {
      allowPrivateHosts,
      timeoutMs: step,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Oboext-Webmention/1.0 (+webmention sender)",
      },
    });
    base = url;
    linkHeader = res.headers.get("link");
    if (res.ok) html = await readCapped(res, MAX_HTML_BYTES);
  } catch (e) {
    log.warn(`[webmention] discovery failed for ${target}: ${e instanceof Error ? e.message : e}`);
    return false;
  }

  const endpoints = discoverEndpoints(html, base, linkHeader);
  if (!endpoints.length) {
    log.debug(`[webmention] ${target} advertises no endpoint`);
    return false;
  }
  const endpoint = endpoints[0]!;
  const check = inspectWebmentionUrl(endpoint, { allowPrivateHosts });
  if (!check.ok) {
    log.warn(`[webmention] ${target} advertises a blocked endpoint (${check.reason})`);
    return false;
  }
  const left = Math.max(1, Math.min(5000, budgetMs - (FETCH_TIMEOUT_MS - step)));
  try {
    const { res } = await safeFetch(endpoint, {
      allowPrivateHosts,
      method: "POST",
      timeoutMs: left,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Oboext-Webmention/1.0 (+webmention sender)",
      },
      body: new URLSearchParams({ source, target }).toString(),
    });
    if (!res.ok) {
      log.warn(`[webmention] ${endpoint} answered ${res.status} for ${target}`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`[webmention] send to ${endpoint} failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

// ----------------------------------------------------------- discovery hook

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

const hookGlobal = globalThis as unknown as { __oboeWebmentionHooks?: boolean };

/**
 * Register the two core hooks. Idempotent across module re-evaluation (a
 * hot-reloaded chunk would otherwise add a second, identical <link> and a
 * second sender per publish), and safe to call from every request path.
 *
 * Called from pages/_middleware.rose (once per request, before any api
 * dispatch) — the middleware is the app's single "this process is live" choke
 * point, so a publish that arrives before any page render still finds the
 * action registered.
 */
export function registerWebmentionHooks(): void {
  if (hookGlobal.__oboeWebmentionHooks) return;
  hookGlobal.__oboeWebmentionHooks = true;

  // Discovery: advertise the endpoint on post pages and the home page only.
  // Admin documents never run the head.tags filter at all; `page`/`archive`/
  // `taxonomy` are excluded because a mention target is a post or the site
  // root, and a link that goes nowhere wastes every crawler's request.
  addFilter<{ nodes: string[]; context?: { kind?: string; siteUrl?: string } }>(
    HOOKS.headTags,
    (payload) => {
      const ctx = payload?.context;
      const kind = ctx?.kind;
      if (!ctx || (kind !== "post" && kind !== "home")) return payload;
      const origin = String(ctx.siteUrl ?? "").trim().replace(/\/+$/, "");
      if (!origin) return payload;
      payload.nodes.push(
        `<link rel="webmention" href="${escapeAttr(origin + WEBMENTION_PATH)}">`,
      );
      return payload;
    },
    20,
  );

  addAction<PostPublishedPayload>(HOOKS.postPublished, (payload) => {
    sendWebmentionsForPost(payload ?? {});
  });
}
