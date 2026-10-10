/**
 * Permalink layer — ported from lib/services/links.ts.
 *
 * Config lives in the options KV (key "permalinks"). The live database ships
 * with an empty options table, so the defaults apply: posts at /blog/<slug>,
 * categories at /blog/category/<slug>, tags at /blog/tag/<slug>. Pinyin /
 * initials modes resolve through the persisted columns the schema carries.
 */
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { options } from "./schema.js";

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

export function categoryUrlFor(cfg: PermalinkConfig, cat: { slug: string }): string {
  return joinPath([...baseSegs(cfg.categoryBase), cat.slug]);
}

export function tagUrlFor(cfg: PermalinkConfig, tag: { slug: string }): string {
  return joinPath([...baseSegs(cfg.tagBase), tag.slug]);
}

export function blogIndexUrlFor(cfg: PermalinkConfig): string {
  const segs = baseSegs(cfg.postBase);
  return joinPath(segs.length ? segs : ["blog"]);
}

/** Pagination href: page 1 is the plain path, later pages carry ?page=. */
export function paginate(path: string, page: number): string {
  const base = path === "/" ? "" : path;
  return page <= 1 ? path : `${base}/?page=${page}`;
}
