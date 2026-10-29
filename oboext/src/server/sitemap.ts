import { applyAsyncFilters, applyFilters, HOOKS } from "./hooks.js";
import {
  listPosts,
  listCategories,
  listTags,
  getSettings,
  counts,
  categoryPostCounts,
  tagPostCounts,
  listAuthorRows,
  authorPostCounts,
  MACHINE_WINDOW_CAP,
} from "./queries.js";
import { listPublishedPages } from "./pages.js";
import { getPermalinkConfig, blogIndexUrlFor, pageIndexUrlFor, authorUrlFor } from "./links.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { splitLocalePath } from "./i18n.js";
import { resolveOrigin } from "./site-origin.js";
import { getActiveThemeSlug } from "./themes.js";
import { themeLayout } from "./theme-chrome.js";
import { blogListSize, categoryListSize, tagListSize } from "./dialects.js";
import { memoQuery } from "./cache.js";

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

  /** The hreflang cluster this URL belongs to. Present on every locale
   *  variant of the same page, so a crawler pairs the translations
   *  directly from the sitemap instead of relying on link crawling. */
  alternates?: { hreflang: string; href: string }[];
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

// Delegates to the shared resolver (BUG.md AB): the sitemap is a cacheable 200
// document whose <loc> bytes are negotiated on the host/forwarding headers, so
// it must follow the exact same origin policy as every page's canonical - one
// spoofed-header request used to poison the shared key with the attacker's
// URLs. See site-origin.ts for the policy.
export function originFromRequest(req: Request): string {
  return resolveOrigin(req.headers);
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

// R150: the skeleton is 10 queries per render - memoized 30s per origin
// (BUG.md AB: the origin is negotiated, so it is part of the key), dropped by
// invalidateContentCaches (`doc:`) at every content write. Unlike the string
// feeds, this payload flows into PLUGIN filters (sitemap.urls) that may mutate
// it, so every caller gets fresh containers from the memo - only the entries'
// string fields stay shared.
async function buildEntries(base: string): Promise<SitemapPayload> {
  return memoQuery(`doc:sitemap:${base}`, 30_000, async () => {
    const p = await buildEntriesRaw(base);
    return {
      ...p,
      entries: p.entries.map((e) => ({
        ...e,
        ...(e.alternates ? { alternates: [...e.alternates] } : {}),
        ...(e.images ? { images: [...e.images] } : {}),
      })),
      posts: [...p.posts],
      pages: [...p.pages],
      categories: [...p.categories],
      tags: [...p.tags],
    };
  });
}

async function buildEntriesRaw(base: string): Promise<SitemapPayload> {
  const [posts, pages, categories, tags, cfg, settings, themeSlug, totals, catCounts, tagCounts, authorRows, authorCounts] =
    await Promise.all([
      // R247: windowCap - the sitemap lists the WHOLE site. limit:10000 used
      // to be silently clamped to 100 (the visitor's ceiling), so a blog past
      // 100 posts shipped a truncated map and the 45k sharding never fired.
      // R247: windowCap - the sitemap lists the WHOLE site. limit:10000 used
      // to be silently clamped to 100 (the visitor's ceiling), so a blog past
      // 100 posts shipped a truncated map and the 45k sharding never fired.
      listPosts({ status: "published", limit: 10000, windowCap: MACHINE_WINDOW_CAP, pinned: false }),
      listPublishedPages({ limit: 10000, windowCap: MACHINE_WINDOW_CAP }),
      listCategories(),
      listTags(),
      getPermalinkConfig(),
      getSettings(),
      getActiveThemeSlug(),
      counts(),
      categoryPostCounts(),
      tagPostCounts(),
      // R180: the author family. Two grouped reads, both memoized 30s under
      // `tax:` — the map is a crawler endpoint, so per-author probes over all
      // accounts would be N+1 on every uncached render.
      listAuthorRows(),
      authorPostCounts(),
    ]);

  // R148: paginated list pages self-canonicalise now (R146), so they belong
  // in the sitemap - page 2+ used to be discoverable only by walking every
  // pager, and a crawler that never walked it never saw that content at all.
  // Page 1 already sits below as the bare path; only page 2..N are added, at
  // lower priority, and the window sizes come from the SAME helpers the
  // loaders resolve - one arithmetic, so an advertised URL can never be a 404
  // and a served page can never be missing from the map. Page counts use
  // counts()/tax counts (published + visible), matching the loaders' totals.
  const layout = themeLayout(themeSlug);
  const blogSize = blogListSize(layout, settings.postsPerPage);
  const catSize = categoryListSize(layout, settings.postsPerPage);
  const tagSize = tagListSize(layout, settings.postsPerPage);
  const pushPages = (
    path: string,
    count: number,
    size: number,
    changefreq: SitemapChangefreq,
  ): void => {
    const totalPages = size > 0 ? Math.ceil(count / size) : 1;
    for (let n = 2; n <= totalPages; n++) {
      entries.push({ loc: `${base}${path}?page=${n}`, changefreq, priority: "0.4" });
    }
  };

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
  pushPages(blogIndex, totals.posts, blogSize, "daily");
  // R226: the archive is an indexable listing (canonical, hreflang, og:*, a
  // CollectionPage of every post) but was missing from the map, so the site's
  // own chronological index was the one listing a crawler could not find.
  entries.push({
    loc: `${base}/archives`,
    // Mirror the per-post rule: fall back to publishedAt, or an archive that
    // only ever got edited before publishing reports no lastmod at all.
    lastmod: latestDay(
      posts.items.map((p) => ({ updatedAt: p.updatedAt ?? p.publishedAt ?? null })),
    ),
    changefreq: "weekly",
    priority: "0.6",
  });
  // R178: the page directory is an indexable listing now, so it belongs in the
  // map beside the post index — and not at all when its base is disabled.
  const pageIndex = pageIndexUrlFor(cfg);
  if (pageIndex) {
    entries.push({
      loc: `${base}${pageIndex}`,
      lastmod: latestDay(pages.items),
      changefreq: "weekly",
      priority: "0.6",
    });
  }
  for (const p of posts.items) {
    const images = p.featuredImage
      ? [p.featuredImage.startsWith("http") ? p.featuredImage : `${base}${p.featuredImage}`]
      : undefined;
    entries.push({
      loc: `${base}${p.url}`,
      lastmod: day(p.updatedAt ?? p.publishedAt),
      changefreq: "weekly",
      priority: "0.8",
      images,
    });
  }
  // R277: PAIRED en posts re-enter the map. R269 removed the blanket /en
  // expansion (fake translations on unpaired rows); now that pairing is real
  // data, an en post WITH a translationOf is its own document and its absence
  // was the map lying by omission. Only paired rows are listed — an
  // untranslated /en/x still serves the zh body and stays out. Each paired
  // entry (and its zh original) carries the exact per-page cluster the HTML
  // head emits, so every alternate confirms back.
  if (posts.items.some((p) => p.translationOf != null)) {
    const byId = new Map(posts.items.map((p) => [p.id, p]));
    for (const p of posts.items) {
      if (p.locale !== "en" || p.translationOf == null) continue;
      const original = byId.get(p.translationOf);
      if (!original) continue;
      const enLoc = `${base}${p.url}`;
      const zhLoc = `${base}${original.url}`;
      const cluster = [
        { hreflang: "en", href: enLoc },
        { hreflang: "zh-CN", href: zhLoc },
        { hreflang: "x-default", href: zhLoc },
      ];
      // The en entry itself, with its cluster (no image duplication: the
      // cover describes the shared content and the zh entry owns it).
      entries.push({
        loc: enLoc,
        lastmod: day(p.updatedAt ?? p.publishedAt),
        changefreq: "weekly",
        priority: "0.8",
        alternates: cluster,
      });
      // The zh original's existing entry gains the same cluster. Find it in
      // place rather than pushing a duplicate URL.
      const zhEntry = entries.find((e) => e.loc === zhLoc);
      if (zhEntry) zhEntry.alternates = cluster;
    }
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
    pushPages(c.url, catCounts.get(c.id) ?? 0, catSize, "weekly");
  }
  for (const t of tags) {
    entries.push({
      loc: `${base}${t.url}`,
      lastmod: day((t as { createdAt?: Date | null }).createdAt),
      changefreq: "weekly",
      priority: "0.4",
    });
    pushPages(t.url, tagCounts.get(t.id) ?? 0, tagSize, "weekly");
  }

  // R180: the author archives, at a lower priority than the taxonomies — a
  // person page is a navigation aid, not the content. Only authors with at
  // least one public post are listed, because the archive itself 404s on an
  // empty one and an advertised URL must never be a 404. lastmod folds the
  // post rows the map already loaded (no extra read); the page window reuses
  // blogSize because authorList windows with blogListSize.
  const authorLatest = new Map<number, string>();
  for (const p of posts.items) {
    const aid = (p as { author?: { id?: number } | null }).author?.id;
    if (aid == null) continue;
    const d = day(p.updatedAt ?? p.publishedAt);
    const cur = authorLatest.get(aid);
    if (d && (!cur || d > cur)) authorLatest.set(aid, d);
  }
  for (const a of authorRows) {
    const n = authorCounts.get(a.id) ?? 0;
    if (!n) continue;
    const url = authorUrlFor(a.id);
    entries.push({
      loc: `${base}${url}`,
      lastmod: authorLatest.get(a.id) ?? fresh,
      changefreq: "weekly",
      priority: "0.5",
    });
    pushPages(url, n, blogSize, "weekly");
  }

  // R269: the en expansion is GONE until content has real per-locale rows.
  // The old code listed /en/* beside every URL and gave both the full
  // hreflang cluster — with one shared body that declared fake translations
  // and doubled the map. /en/* stays reachable for readers (switcher,
  // in-page links); it just no longer advertises itself to crawlers.
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
  for (const alt of e.alternates ?? []) {
    parts.push(
      `<xhtml:link rel="alternate" hreflang="${esc(alt.hreflang)}" href="${esc(alt.href)}" />`,
    );
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
  const hasAlternates = entries.some((e) => (e.alternates?.length ?? 0) > 0);
  const ns =
    (hasImages ? ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' : "") +
    (hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : "");
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

// SEO hard rule: one sitemap FILE may hold at most 50,000 URLs / 50MB; past
// that the protocol requires a sitemap index pointing at sharded files.
// 45,000 leaves margin under the 50k hard limit.
export const SITEMAP_SLICE_MAX_URLS = 45_000;
// shortcut: sharding counts URLs only — the 50MB half of the limit is assumed
// unreachable at 45k URLs; add per-slice byte accounting if a slice can exceed
// 49MB (image-heavy maps).
// Child slices live at /sitemap-1.xml, /sitemap-2.xml… (routed in
// _middleware.rose); the robots.txt Sitemap: line keeps pointing at
// /sitemap.xml, which is legal for an index too.

/** The /sitemap.xml body: a plain urlset while the map fits one file
 *  (back-compat — unchanged output for small sites), a sitemap index of
 *  /sitemap-N.xml slices once it does not. */
export function renderSitemapSharded(
  entries: SitemapEntry[],
  base: string,
): string {
  if (entries.length <= SITEMAP_SLICE_MAX_URLS) {
    return renderSitemapUrlset(entries);
  }
  const count = Math.ceil(entries.length / SITEMAP_SLICE_MAX_URLS);
  return renderSitemapIndex(
    Array.from({ length: count }, (_, i) => ({
      loc: `${base}/sitemap-${i + 1}.xml`,
    })),
  );
}

/** The body of one /sitemap-N.xml child, in the entry order the map already
 *  assembles in. null when the map still fits a single file (no index ever
 *  references a slice then) or the part is out of range — the caller 404s. */
export function renderSitemapSlice(
  entries: SitemapEntry[],
  part: number,
): string | null {
  if (entries.length <= SITEMAP_SLICE_MAX_URLS) return null;
  const start = (part - 1) * SITEMAP_SLICE_MAX_URLS;
  if (start < 0 || start >= entries.length) return null;
  return renderSitemapUrlset(
    entries.slice(start, start + SITEMAP_SLICE_MAX_URLS),
  );
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
  // R229: a site set to noindex gets `Disallow: /` from robots.txt, and a
  // sitemap that still lists every URL is the one document inviting a crawler
  // into a site that just closed its door. The map answers 404 (the "no such
  // resource" the middleware already turns a null doc into) for as long as the
  // setting holds - flipping it back restores the map on the next request.
  const settings = await getSettings();
  if ((settings.seoRobots || "").toLowerCase().includes("noindex")) return null;
  const payload = await buildSitemapPayload(req);
  const url = new URL(req.url);
  const searchParams = url.searchParams;
  const XML_TYPE = "application/xml; charset=utf-8";

  // A sharded child (/sitemap-N.xml, /en/sitemap-N.xml) is core-owned: the
  // sitemap.document filters claim /sitemap.xml (?part/?kind), so running them
  // here would let sitemap-plus swap the slice out for its own index. The
  // sitemap.urls filters already ran inside buildSitemapPayload, so the slice
  // content is still the filtered map. renderSitemapSlice rejects part 0 and
  // out-of-range parts, so a bogus part answers a real 404.
  const slice = /^\/sitemap-(\d+)\.xml$/.exec(
    splitLocalePath(url.pathname).path,
  );
  if (slice) {
    if (searchParams.size > 0) return null; // unclaimed query = real 404
    const xml = renderSitemapSlice(payload.entries, Number(slice[1]));
    return xml ? { contentType: XML_TYPE, xml } : null;
  }

  // Threshold branch: single urlset while the map fits one file (the output
  // every existing consumer and test pins), a sitemap index of /sitemap-N.xml
  // slices above it. Query strings stay unclaimed for the plugin hooks.
  const doc: SitemapDocument | null =
    searchParams.size === 0
      ? {
          contentType: XML_TYPE,
          xml: renderSitemapSharded(payload.entries, payload.base),
        }
      : null;
  const out = await applyAsyncFilters(HOOKS.sitemapDocument, {
    ...payload,
    searchParams,
    doc,
  } satisfies SitemapDocumentPayload);
  return out.doc;
}

/**
 * The /robots.txt body. Single source of truth: the middleware route
 * (documents.robots in loaders.ts) delegates here. `origin` is the request
 * origin (scheme://host), used for the Sitemap line.
 */
export async function buildRobotsTxt(origin: string): Promise<string> {
  const settings = await getSettings();
  await ensurePluginsLoaded();

  if ((settings.seoRobots || "").toLowerCase().includes("noindex")) {
    const blocked = applyFilters(HOOKS.robotsRules, {
      lines: ["User-agent: *", "Disallow: /"],
      base: origin,
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
      `Sitemap: ${origin}/sitemap.xml`,
    ],
    base: origin,
  } satisfies RobotsPayload);
  return `${payload.lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
