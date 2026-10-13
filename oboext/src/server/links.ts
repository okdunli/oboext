

import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { options } from "./schema.js";
import { setOption } from "./options.js";
import type { PostView } from "./queries.js";
import type { PageView } from "./pages.js";
import type { Category, Tag } from "./schema.js";

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

let cachedAt = 0;
let cachedCfg: PermalinkConfig = DEFAULT_PERMALINKS;

/** Read + normalize the permalink config (tiny in-process TTL: config rarely changes). */
export async function getPermalinkConfig(): Promise<PermalinkConfig> {
  const now = Date.now();
  if (cachedAt && now - cachedAt < 30_000) return cachedCfg;
  let stored: Partial<PermalinkConfig> = {};
  try {
    const rows = await db
      .select({ value: options.value })
      .from(options)
      .where(eq(options.key, OPTION_KEY))
      .limit(1);
    if (rows[0]?.value && typeof rows[0].value === "object") {
      stored = rows[0].value as Partial<PermalinkConfig>;
    }
  } catch {
    stored = {};
  }
  cachedCfg = normalizePermalinkConfig({ ...DEFAULT_PERMALINKS, ...stored });
  cachedAt = now;
  return cachedCfg;
}

/** Drop the cached config after an admin save (B phase). */
export function invalidatePermalinkConfig(): void {
  cachedAt = 0;
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

/** Which persisted column a captured tail segment reverses through. */
type SlugKind = "slug" | "pinyin" | "initial";

type TailMatcher = {
  regex: RegExp;
  hasId: boolean;
  slugGroup: SlugKind | null;
  segCount: number;
};

/** Compile the active post tail shape (custom pattern → named-group regex). */
export function buildTailMatcher(cfg: PermalinkConfig): TailMatcher {
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
    return { slug: decodeURIComponent(g[m.slugGroup]), slugKind: m.slugGroup, ...key };
  }
  return null;
}

function dateTokensMatch(post: PostView, parts: Record<string, string>): boolean {
  const d = post.publishedAt ? new Date(post.publishedAt)
    : post.createdAt ? new Date(post.createdAt) : new Date();
  const actual: Record<string, string> = {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1).padStart(2, "0"),
    day: String(d.getDate()).padStart(2, "0"),
  };
  return Object.entries(parts).every(([k, v]) => v.padStart(2, "0") === actual[k]);
}

/** Resolve a post tail to a published post (null when nothing matches). */
async function fetchPostByTail(
  tail: string[],
  cfg: PermalinkConfig,
): Promise<PostView | null> {
  const key = matchPostTail(cfg, tail);
  if (!key) return null;

  const { getPost } = await import("./queries.js");
  try {
    const post = await getPost(String(key.slug ?? key.id ?? ""));
    if (post && key.dateParts && !dateTokensMatch(post, key.dateParts)) return null;
    return post;
  } catch {
    return null;
  }
}

export type SitePathResolution =
  | { kind: "home" }
  | { kind: "blogIndex" }
  | { kind: "post"; post: PostView }
  | { kind: "page"; page: PageView }
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
  const segments = rawSegments.map((s) => decodeURIComponent(s)).filter(Boolean);
  if (!segments.length) return { kind: "home" };

  const pb = baseSegs(cfg.postBase);
  const pgb = baseSegs(cfg.pageBase);
  const cb = baseSegs(cfg.categoryBase);
  const tb = baseSegs(cfg.tagBase);
  const tailMatcher = buildTailMatcher(cfg);

  if (pb.length && segments.length === pb.length && startsWith(segments, pb)) {
    return { kind: "blogIndex" };
  }

  if (startsWith(segments, pb)) {
    const post = await fetchPostByTail(segments.slice(pb.length), cfg);
    if (post) return { kind: "post", post };
  }
  if (startsWith(segments, pgb) && segments.length === pgb.length + 1) {
    const { getPublishedPage } = await import("./pages.js");
    try {
      const page = await getPublishedPage(segments[pgb.length]);
      if (page) return { kind: "page", page };
    } catch {
      /* fall through */
    }
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

  if (segments.length === 1) {

    if (pb.length === 0 && segments[0] === ROOT_BLOG_INDEX_SEGMENT) {
      return { kind: "blogIndex" };
    }
    const post = await fetchPostByTail(segments, cfg);
    if (post) return { kind: "post", post };
    const { getPublishedPage } = await import("./pages.js");
    try {
      const page = await getPublishedPage(segments[0]);
      if (page) return { kind: "page", page };
    } catch {
      /* continue */
    }
    const { getCategoryBySlug, getTagBySlug } = await import("./queries.js");
    const category = await getCategoryBySlug(segments[0]);
    if (category) return { kind: "category", category };
    const tag = await getTagBySlug(segments[0]);
    if (tag) return { kind: "tag", tag };
    return null;
  }

  if (pb.length === 0 && segments.length === tailMatcher.segCount) {
    const post = await fetchPostByTail(segments, cfg);
    if (post) return { kind: "post", post };
  }

  return null;
}
