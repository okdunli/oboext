import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { options } from "./schema.js";
import { setOption } from "./options.js";
import { memoStrict, memoQuery, invalidate, SIDEBAR_TTL } from "./cache.js";
import type { PostRow } from "./queries.js";
import type { Category, Tag, Page } from "./schema.js";
import { createLogger } from "./logger.js";
const log = createLogger("links");

export type PostLinkMode = "slug" | "id" | "pinyin" | "initial" | "custom";

export interface PermalinkConfig {
  postMode: PostLinkMode;
  postPattern: string;
  postBase: string;
  pageBase: string;
  categoryBase: string;
  tagBase: string;
}

const OPTION_KEY = "permalinks";

export const DEFAULT_PERMALINKS: PermalinkConfig = {
  postMode: "slug",
  postPattern: "{slug}",
  postBase: "blog",
  pageBase: "pages",
  categoryBase: "blog/category",
  tagBase: "blog/tag",
};

const MODES: PostLinkMode[] = ["slug", "id", "pinyin", "initial", "custom"];

function normalizeBase(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/[^\p{L}\p{N}\-/_]/gu, "")
    .toLowerCase();
}

function normalizePattern(raw: unknown): string {
  const p = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  return /\{(id|slug|pinyin|initial)\}/.test(p) ? p : "{slug}";
}

export function normalizePermalinkConfig(input: Partial<PermalinkConfig>): PermalinkConfig {
  const cfg: PermalinkConfig = {
    postMode: MODES.includes(input.postMode as PostLinkMode)
      ? (input.postMode as PostLinkMode)
      : DEFAULT_PERMALINKS.postMode,
    postPattern: normalizePattern(input.postPattern ?? DEFAULT_PERMALINKS.postPattern),
    postBase: normalizeBase(input.postBase ?? DEFAULT_PERMALINKS.postBase),
    pageBase: normalizeBase(input.pageBase ?? DEFAULT_PERMALINKS.pageBase),
    categoryBase: normalizeBase(input.categoryBase ?? DEFAULT_PERMALINKS.categoryBase),
    tagBase: normalizeBase(input.tagBase ?? DEFAULT_PERMALINKS.tagBase),
  };
  if (cfg.postMode !== "custom") cfg.postPattern = "{slug}";
  return cfg;
}

// Read + normalize the permalink config (30s in-process TTL: config rarely changes).
export async function getPermalinkConfig(): Promise<PermalinkConfig> {
  try {
    return await memoStrict("permalink", 30_000, async () => {
      const rows = await db
        .select({ value: options.value })
        .from(options)
        .where(eq(options.key, OPTION_KEY))
        .limit(1);
      const stored =
        rows[0]?.value && typeof rows[0].value === "object"
          ? (rows[0].value as Partial<PermalinkConfig>)
          : {};
      return normalizePermalinkConfig({ ...DEFAULT_PERMALINKS, ...stored });
    });
  } catch (e) {
    // A failed read must NOT be cached.
    log.warn(
      `[links] permalink config read failed, using defaults for this request: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return normalizePermalinkConfig(DEFAULT_PERMALINKS);
  }
}

/** Drop the cached config after an admin save (B phase). */
export function invalidatePermalinkConfig(): void {
  invalidate("permalink");
}

export async function savePermalinkConfig(
  input: Partial<PermalinkConfig>,
): Promise<PermalinkConfig> {
  const cfg = normalizePermalinkConfig(input);
  await setOption(OPTION_KEY, cfg);
  invalidatePermalinkConfig();
  return cfg;
}

const baseSegs = (base: string): string[] => (base ? base.split("/").filter(Boolean) : []);

const joinPath = (parts: (string | number)[]): string => {
  const segs = parts.map((p) => String(p)).filter(Boolean);
  return segs.length ? "/" + segs.join("/") : "/";
};

type PostUrlInput = {
  id: number;
  slug: string;
  pinyinSlug?: string | null;
  initialSlug?: string | null;
  title?: string | null;
  publishedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

function dateParts(post: PostUrlInput): { year: string; month: string; day: string } {
  const d = post.publishedAt
    ? new Date(post.publishedAt)
    : post.createdAt
      ? new Date(post.createdAt)
      : new Date();
  return {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1).padStart(2, "0"),
    day: String(d.getDate()).padStart(2, "0"),
  };
}

function postTailSegments(cfg: PermalinkConfig, post: PostUrlInput): string[] {
  switch (cfg.postMode) {
    case "id":
      return [String(post.id)];
    // pinyin/initials resolve through the persisted tails (no pinyin dictionary needed)
    case "pinyin":
      return [post.pinyinSlug || post.slug];
    case "initial":
      return [post.initialSlug || post.slug];
    case "custom": {
      const dt = dateParts(post);
      const tokens: Record<string, string> = {
        "{id}": String(post.id),
        "{slug}": post.slug,
        "{pinyin}": post.pinyinSlug || post.slug,
        "{initial}": post.initialSlug || post.slug,
        "{year}": dt.year,
        "{month}": dt.month,
        "{day}": dt.day,
      };
      return cfg.postPattern
        .split("/")
        .map((seg) => seg.replace(/\{(id|slug|pinyin|initial|year|month|day)\}/g, (k) => tokens[k] ?? ""))
        .filter(Boolean);
    }
    default:
      return [post.slug];
  }
}

export function postUrlFor(cfg: PermalinkConfig, post: PostUrlInput): string {
  return joinPath([...baseSegs(cfg.postBase), ...postTailSegments(cfg, post)]);
}

export function pageUrlFor(cfg: PermalinkConfig, page: { slug: string }): string {
  return joinPath([...baseSegs(cfg.pageBase), page.slug]);
}

export function categoryUrlFor(cfg: PermalinkConfig, cat: { slug: string }): string {
  return joinPath([...baseSegs(cfg.categoryBase), cat.slug]);
}

export function tagUrlFor(cfg: PermalinkConfig, tag: { slug: string }): string {
  return joinPath([...baseSegs(cfg.tagBase), tag.slug]);
}

export function blogIndexUrlFor(cfg: PermalinkConfig): string {
  const segs = baseSegs(cfg.postBase);

  return joinPath(segs.length ? segs : [ROOT_BLOG_INDEX_SEGMENT]);
}

export const ROOT_BLOG_INDEX_SEGMENT = "blog";

/** Pagination href: page 1 is the plain path, later pages carry ?page=. */
export function paginate(path: string, page: number): string {

  if (page <= 1) return path;
  return path === "/" ? `/?page=${page}` : `${path}?page=${page}`;
}

// ---------------------------------------------------------------------------
// Resolution (routes side) — ported from lib/services/links.ts
// ---------------------------------------------------------------------------

/** Which persisted column a captured tail segment reverses through. */
type SlugKind = "slug" | "pinyin" | "initial";

type TailMatcher = {
  regex: RegExp;
  hasId: boolean;
  slugGroup: SlugKind | null;
  segCount: number;
};

/**
 * The compiled matcher for one permalink shape. resolveSitePath() builds it on
 * every catch-all request, and matchPostTail() builds it again for the same
 * config — so a root-level probe compiled the regex (plus the split/replace
 * pass over the pattern) twice per request, on the route bots hit hardest.
 * The matcher is a pure function of postMode + postPattern, so one instance per
 * shape serves every request; a permalink change yields a new key and can never
 * be handed a stale matcher. Neither regex carries a /g or /y flag and both are
 * only read through String.match(), which ignores lastIndex for a non-global
 * regex — so sharing one instance across concurrent requests is safe.
 */
const tailMatchers = new Map<string, TailMatcher>();

/** Compile the active post tail shape (custom pattern → named-group regex). */
export function buildTailMatcher(cfg: PermalinkConfig): TailMatcher {
  const key = cfg.postMode + "\u0000" + cfg.postPattern;
  const hit = tailMatchers.get(key);
  if (hit) return hit;
  const built = compileTailMatcher(cfg);
  tailMatchers.set(key, built);
  return built;
}

function compileTailMatcher(cfg: PermalinkConfig): TailMatcher {
  if (cfg.postMode === "custom") {
    const groups = cfg.postPattern.split("/").map((seg) =>
      seg
        .replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "{" || ch === "}" ? ch : "\\" + ch))
        .replace(/\{id\}/g, "(?<id>\\d+)")
        .replace(/\{pinyin\}/g, "(?<pinyin>[^/]+)")
        .replace(/\{initial\}/g, "(?<initial>[^/]+)")
        .replace(/\{slug\}/g, "(?<slug>[^/]+)")
        .replace(/\{year\}/g, "(?<year>\\d{4})")
        .replace(/\{(month|day)\}/g, "(?<$1>\\d{1,2})"),
    );
    const pattern = groups.join("/");
    // Reverse-lookup preference: id > pinyin > initial > slug (a pattern
    // containing several text tokens is exotic; this order stays deterministic).
    const slugGroup: SlugKind | null = pattern.includes("(?<pinyin>")
      ? "pinyin"
      : pattern.includes("(?<initial>")
        ? "initial"
        : pattern.includes("(?<slug>")
          ? "slug"
          : null;
    return {
      regex: new RegExp("^" + pattern + "$"),
      hasId: pattern.includes("(?<id>"),
      slugGroup,
      segCount: groups.length,
    };
  }
  if (cfg.postMode === "id") {
    return { regex: /^(?<id>\d+)$/, hasId: true, slugGroup: null, segCount: 1 };
  }
  const kind: SlugKind = cfg.postMode === "pinyin" ? "pinyin" : cfg.postMode === "initial" ? "initial" : "slug";
  return { regex: new RegExp(`^(?<${kind}>[^/]+)$`), hasId: false, slugGroup: kind, segCount: 1 };
}

/** Pure: does a tail match the post shape, and which lookup key does it yield? */
export function matchPostTail(
  cfg: PermalinkConfig,
  tail: string[],
): { id?: number; slug?: string; slugKind?: SlugKind; dateParts?: Record<string, string> } | null {
  const m = buildTailMatcher(cfg);
  if (tail.length !== m.segCount) return null;
  const hit = tail.join("/").match(m.regex);
  if (!hit) return null;
  const g = hit.groups ?? {};

  const dateParts: Record<string, string> = {};
  for (const k of ["year", "month", "day"] as const) if (g[k]) dateParts[k] = g[k];
  const key = { dateParts: Object.keys(dateParts).length ? dateParts : undefined };
  if (m.hasId && g.id) return { id: Number(g.id), ...key };
  if (m.slugGroup && g[m.slugGroup]) {
    // No decode here: resolveSitePath already decoded every raw segment once
    // before probing (its map is the single decode). A second
    // decodeURIComponent would throw URIError on a literal "%z"/"a%zzb"
    // segment the caller deliberately kept as-is - the same malformed-escape
    // probes the decode-or-literal there exists to absorb - and the throw
    // would escape as an uncached 500 instead of a clean 404.
    return { slug: g[m.slugGroup], slugKind: m.slugGroup, ...key };
  }
  return null;
}

function dateTokensMatch(post: { publishedAt?: Date | string | null; createdAt?: Date | string | null }, parts: Record<string, string>): boolean {
  const d = post.publishedAt ? new Date(post.publishedAt)
    : post.createdAt ? new Date(post.createdAt) : new Date();
  const actual: Record<string, string> = {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1).padStart(2, "0"),
    day: String(d.getDate()).padStart(2, "0"),
  };
  return Object.entries(parts).every(([k, v]) => v.padStart(2, "0") === actual[k]);
}

/** Resolve a post tail to a published post (null when nothing matches).
 *  Returns the RAW row, not a hydrated view: the detail loader folds the
 *  taxonomy/metas reads into its own concurrency wave, so hydrating here
 *  would be a dedicated round trip per cold view.
 *
 *  Memoized (SWR, `rp:`) for the same reason the taxonomy/page slug lookups
 *  are: the catch-all router probes this on every render — the root-level
 *  fallback wave always includes it — and the detail loader then reuses the
 *  row as `preloaded`. Under the 1s public render cache that was a remote
 *  round trip per second. Post writes drop it via invalidateContentCaches;
 *  the permalink fingerprint in the key means a mode/pattern change (which
 *  only invalidates `permalink`) cannot serve a tail resolved under the old
 *  config. */
async function fetchPostByTail(
  tail: string[],
  cfg: PermalinkConfig,
): Promise<PostRow | null> {
  const key = matchPostTail(cfg, tail);
  if (!key) return null;

  // A DB failure PROPAGATES rather than collapsing to null. `null` here means
  // "no such post", and the caller (resolveSitePath → the catch-all loader)
  // memoizes a null as a CONFIRMED 404 in the `pathmiss:` negative cache —
  // so swallowing a transient query error into null would pin a valid post URL
  // to 404 for the whole negative-cache TTL. The memo does not cache the
  // rejection either (runOnce clears its in-flight marker), so the next read
  // re-runs the query.
  return memoQuery<PostRow | null>(
    `rp:${cfg.postMode}|${cfg.postPattern}|${tail.join("/")}`,
    SIDEBAR_TTL,
    async () => {
      const { getPostRow } = await import("./queries.js");
      const row = await getPostRow(String(key.slug ?? key.id ?? ""));
      // A date mismatch is a real "no such post" and IS worth caching.
      if (row && key.dateParts && !dateTokensMatch(row.post, key.dateParts)) return null;
      return row;
    },
  );
}

export type SitePathResolution =
  | { kind: "home" }
  | { kind: "blogIndex" }
  | { kind: "post"; post: PostRow }
  | { kind: "page"; page: Page }
  | { kind: "category"; category: Category }
  | { kind: "tag"; tag: Tag };

function startsWith(segs: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((s, i) => s === segs[i]);
}

/**
 * Resolve an arbitrary site path (used by the root catch-all, so prefixes can
 * be renamed or deleted). Root-level collisions resolve post → page →
 * category → tag; trade-off: cross-type same-slug collisions are left to
 * authors, upgrade path is a per-type disambiguation table.
 */
export async function resolveSitePath(
  rawSegments: string[],
): Promise<SitePathResolution | null> {
  const cfg = await getPermalinkConfig();
  // Decode-or-literal, not a bare decodeURIComponent: the handler receives the
  // RAW url (prod-server decodes only for its static layer; the edge adapter
  // never does), so this is the single decode. A malformed escape - "/%z", the
  // "%00"/"%2e" family scanners send - would throw URIError and turn a probe
  // into an uncached 500. Treating it as a literal segment resolves to a clean
  // 404 that the caller's negative cache can then absorb.
  const decodedSegments = rawSegments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  // Postgres rejects a NUL byte in a text parameter, so "/%00" (constant
  // scanner traffic) would burn all four entity probes on doomed queries and
  // answer 500. A NUL can never name a real entity: the path is unresolvable,
  // and returning null lets the caller negative-cache a clean 404 instead.
  if (decodedSegments.some((s) => s.includes("\u0000"))) return null;
  const segments = decodedSegments.filter(Boolean);
  if (!segments.length) return { kind: "home" };

  const pb = baseSegs(cfg.postBase);
  const pgb = baseSegs(cfg.pageBase);
  const cb = baseSegs(cfg.categoryBase);
  const tb = baseSegs(cfg.tagBase);
  const tailMatcher = buildTailMatcher(cfg);

  // Post listing index: exact match of a non-empty post base.
  if (pb.length && segments.length === pb.length && startsWith(segments, pb)) {
    return { kind: "blogIndex" };
  }

  // Prefixed entities.
  if (startsWith(segments, pb)) {
    const post = await fetchPostByTail(segments.slice(pb.length), cfg);
    if (post) return { kind: "post", post };
  }
  if (startsWith(segments, pgb) && segments.length === pgb.length + 1) {
    // Raw row, like the post branch: the detail loader folds the metas
    // hydration into its own wave. No try/catch: this branch is gated on the
    // page base, so the category/tag branches below can never match the same
    // path — swallowing a query error here would only convert it into a null,
    // which the caller then negative-caches as a confirmed 404.
    const { getPublishedPageRow } = await import("./pages.js");
    const page = await getPublishedPageRow(segments[pgb.length]);
    if (page) return { kind: "page", page };
  }
  if (startsWith(segments, cb) && segments.length === cb.length + 1) {
    const { getCategoryBySlug } = await import("./queries.js");
    const category = await getCategoryBySlug(segments[cb.length]);
    if (category) return { kind: "category", category };
  }
  if (startsWith(segments, tb) && segments.length === tb.length + 1) {
    const { getTagBySlug } = await import("./queries.js");
    const tag = await getTagBySlug(segments[tb.length]);
    if (tag) return { kind: "tag", tag };
  }

  // Root-level single segment (prefixes deleted): try every entity type.
  if (segments.length === 1) {

    if (pb.length === 0 && segments[0] === ROOT_BLOG_INDEX_SEGMENT) {
      return { kind: "blogIndex" };
    }
    // One parallel wave, not four serial probes: the lookups are independent
    // reads and only the result ORDER encodes the documented priority
    // (post → page → category → tag). At remote-Postgres RTT the serial
    // version paid 4 round trips for every unknown path - the whole cost of
    // a 404 was these probes, and bots probe constantly.
    //
    // allSettled, not all: a probe that FAILS must not stop another entity
    // type from resolving (a transient page-probe error should not 500 a
    // valid category). But a probe that failed and left NOTHING resolved means
    // the DB could not answer — rethrow below so the caller answers 500
    // instead of negative-caching a 404 it never confirmed.
    const { getPublishedPageRow } = await import("./pages.js");
    const { getCategoryBySlug, getTagBySlug } = await import("./queries.js");
    const [postR, pageR, catR, tagR] = await Promise.allSettled([
      fetchPostByTail(segments, cfg),
      getPublishedPageRow(segments[0]),
      getCategoryBySlug(segments[0]),
      getTagBySlug(segments[0]),
    ]);
    const post = postR.status === "fulfilled" ? postR.value : null;
    const page = pageR.status === "fulfilled" ? pageR.value : null;
    const category = catR.status === "fulfilled" ? catR.value : null;
    const tag = tagR.status === "fulfilled" ? tagR.value : null;
    if (post) return { kind: "post", post };
    if (page) return { kind: "page", page };
    if (category) return { kind: "category", category };
    if (tag) return { kind: "tag", tag };
    for (const r of [postR, pageR, catR, tagR]) if (r.status === "rejected") throw r.reason;
    return null;
  }

  // Posts at root with multi-segment custom patterns (e.g. {year}/{slug}).
  if (pb.length === 0 && segments.length === tailMatcher.segCount) {
    const post = await fetchPostByTail(segments, cfg);
    if (post) return { kind: "post", post };
  }

  return null;
}
