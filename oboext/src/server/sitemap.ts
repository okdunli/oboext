

import { applyAsyncFilters, applyFilters, HOOKS } from "./hooks.js";
import { listPosts, listCategories, listTags, getSettings } from "./queries.js";
import { listPublishedPages } from "./pages.js";
import { getPermalinkConfig, blogIndexUrlFor } from "./links.js";
import { ensurePluginsLoaded } from "./plugins.js";

export type SitemapChangefreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export type SitemapEntry = {

  loc: string;

  lastmod?: string;
  changefreq?: SitemapChangefreq;

  priority?: string;

  images?: string[];
};

type CategoryItem = Awaited<ReturnType<typeof listCategories>>[number];
type TagItem = Awaited<ReturnType<typeof listTags>>[number];
type PostItem = Awaited<ReturnType<typeof listPosts>>["items"][number];
type PageItem = Awaited<ReturnType<typeof listPublishedPages>>["items"][number];

export type SitemapPayload = {
  entries: SitemapEntry[];
  base: string;
  posts: PostItem[];
  pages: PageItem[];
  categories: CategoryItem[];
  tags: TagItem[];
};

export type SitemapDocument = {
  contentType: string;
  xml: string;
};

export type SitemapDocumentPayload = SitemapPayload & {
  searchParams: URLSearchParams;
  doc: SitemapDocument | null;
};

export type RobotsPayload = {
  lines: string[];
  base: string;
};

const CHANGEFREQS: ReadonlySet<string> = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

export function originFromRequest(req: Request): string {
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    req.headers.get("host") ||
    "localhost:3000";
  const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function day(value?: Date | string | null): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function latestDay(items: { updatedAt?: Date | null }[]): string | undefined {
  let best: string | undefined;
  for (const it of items) {
    const d = day(it.updatedAt);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

async function buildEntries(base: string): Promise<SitemapPayload> {
  const [posts, pages, categories, tags, cfg] = await Promise.all([
    listPosts({ status: "published", limit: 10000, pinned: false }),
    listPublishedPages({ limit: 10000 }),
    listCategories(),
    listTags(),
    getPermalinkConfig(),
  ]);

  const blogIndex = blogIndexUrlFor(cfg);
  const fresh = latestDay(posts.items);
  const entries: SitemapEntry[] = [

    { loc: `${base}/`, lastmod: fresh, changefreq: "daily", priority: "1.0" },
  ];

  if (blogIndex !== "/") {
    entries.push({
      loc: `${base}${blogIndex}`,
      lastmod: fresh,
      changefreq: "daily",
      priority: "0.8",
    });
  }
  for (const p of posts.items) {
    entries.push({
      loc: `${base}${p.url}`,
      lastmod: day(p.updatedAt ?? p.publishedAt),
      changefreq: "weekly",
      priority: "0.8",
    });
  }
  for (const p of pages.items) {
    entries.push({
      loc: `${base}${p.url}`,
      lastmod: day(p.updatedAt ?? p.publishedAt),
      changefreq: "monthly",
      priority: "0.7",
    });
  }
  for (const c of categories) {
    entries.push({
      loc: `${base}${c.url}`,
      lastmod: day((c as { createdAt?: Date | null }).createdAt),
      changefreq: "weekly",
      priority: "0.6",
    });
  }
  for (const t of tags) {
    entries.push({
      loc: `${base}${t.url}`,
      lastmod: day((t as { createdAt?: Date | null }).createdAt),
      changefreq: "weekly",
      priority: "0.4",
    });
  }

  return {
    entries,
    base,
    posts: posts.items,
    pages: pages.items,
    categories,
    tags,
  };
}

export function renderSitemapEntry(e: SitemapEntry): string {
  const parts = [`<loc>${esc(e.loc)}</loc>`];
  if (e.lastmod) parts.push(`<lastmod>${e.lastmod}</lastmod>`);
  if (e.changefreq && CHANGEFREQS.has(e.changefreq)) {
    parts.push(`<changefreq>${e.changefreq}</changefreq>`);
  }

  if (e.priority && /^(0(\.\d)?|1(\.0)?)$/.test(e.priority)) {
    parts.push(`<priority>${e.priority}</priority>`);
  }
  for (const img of e.images ?? []) {

    if (/^https?:\/\//i.test(img)) {
      parts.push(
        `<image:image><image:loc>${esc(img)}</image:loc></image:image>`,
      );
    }
  }
  return `<url>${parts.join("")}</url>`;
}

export function renderSitemapUrlset(entries: SitemapEntry[]): string {
  const hasImages = entries.some((e) => (e.images?.length ?? 0) > 0);
  const ns = hasImages
    ? ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'
    : "";
  const body = entries.map((e) => renderSitemapEntry(e)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${ns}>
${body}
</urlset>`;
}

export function renderSitemapIndex(
  items: { loc: string; lastmod?: string }[],
): string {
  const body = items
    .map(
      (it) =>
        `<sitemap><loc>${esc(it.loc)}</loc>${
          it.lastmod ? `<lastmod>${it.lastmod}</lastmod>` : ""
        }</sitemap>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</sitemapindex>`;
}

export async function buildSitemapPayload(req: Request): Promise<SitemapPayload> {
  const base = originFromRequest(req);
  const payload = await buildEntries(base);
  await ensurePluginsLoaded();
  return applyAsyncFilters(HOOKS.sitemapUrls, payload);
}

export async function buildSitemapDocument(
  req: Request,
): Promise<SitemapDocument | null> {
  const payload = await buildSitemapPayload(req);
  const searchParams = new URL(req.url).searchParams;
  const doc: SitemapDocument | null =
    searchParams.size === 0
      ? { contentType: "application/xml; charset=utf-8", xml: renderSitemapUrlset(payload.entries) }
      : null;
  const out = await applyAsyncFilters(HOOKS.sitemapDocument, {
    ...payload,
    searchParams,
    doc,
  } satisfies SitemapDocumentPayload);
  return out.doc;
}

export async function buildRobotsTxt(req: Request): Promise<string> {
  const base = originFromRequest(req);
  const settings = await getSettings();
  await ensurePluginsLoaded();

  if ((settings.seoRobots || "").toLowerCase().includes("noindex")) {
    const blocked = applyFilters(HOOKS.robotsRules, {
      lines: ["User-agent: *", "Disallow: /"],
      base,
    } satisfies RobotsPayload);
    return `${blocked.lines.join("\n").trimEnd()}\n`;
  }

  const payload = applyFilters(HOOKS.robotsRules, {
    lines: [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /api/",
      "Disallow: /search",
      "",
      `Sitemap: ${base}/sitemap.xml`,
    ],
    base,
  } satisfies RobotsPayload);
  return `${payload.lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
