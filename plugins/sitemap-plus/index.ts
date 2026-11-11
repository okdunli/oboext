import type { Block } from "../../oboext/src/server/schema.js";
import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import { getSettings } from "../../oboext/src/server/queries.js";
import type {
  RobotsPayload,
  SitemapChangefreq,
  SitemapDocumentPayload,
  SitemapEntry,
  SitemapPayload,
} from "../../oboext/src/server/sitemap.js";
import {
  day as siteDay,
  renderSitemapEntry,
  renderSitemapIndex,
  renderSitemapUrlset,
} from "../../oboext/src/server/sitemap.js";

type Settings = {
  includePages: boolean;
  includeCategories: boolean;
  includeTags: boolean;
  lastmodSource: "updated" | "published";
  changefreq: string;
  postPriority: string;
  pagePriority: string;
  images: boolean;
  imageFeatured: boolean;
  imageContent: boolean;
  excludeKeywords: string;
  extraUrls: string;

  newsEnabled: boolean;
  newsLanguage: string;
  newsHours: number;
  shardMaxUrls: number;
  shardMaxMb: number;
};

const CHANGEFREQS = new Set<string>([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

// R532: the plugin used to compute lastmod with toISOString(), i.e. in UTC.
// The core labels lastmod with the SITE's calendar day (a post published at
// 20:00 UTC belongs to the next day in Asia/Shanghai), and this filter
// OVERWRITES the core's value - so the plugin silently moved every
// late-evening post one day into the past. The site's own day() is the single
// source of truth now, and the timezone comes from the same settings row the
// core reads.


function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absolute(u: string, base: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  return base + (u.startsWith("/") ? u : `/${u}`);
}

function contentImages(blocks: Block[] | null | undefined): string[] {
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "image" && b.url) {
      out.push(b.url);
    } else if (b.type === "html") {
      for (const m of b.html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
        out.push(m[1]);
      }
    }
  }
  return out;
}

function lines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Shard = { entries: SitemapEntry[]; lastmod?: string };

function buildShards(
  entries: SitemapEntry[],
  maxUrls: number,
  maxBytes: number,
): Shard[] {
  const limit = Math.max(1, Math.floor(maxUrls) || 1);
  const budget = Math.max(1024, Math.floor(maxBytes) || 1);
  const shards: Shard[] = [];
  let cur: SitemapEntry[] = [];
  let curBytes = 0;
  let curLast: string | undefined;

  const flush = () => {
    shards.push({ entries: cur, lastmod: curLast });
    cur = [];
    curBytes = 0;
    curLast = undefined;
  };

  for (const e of entries) {

    const bytes = Buffer.byteLength(renderSitemapEntry(e), "utf8") + 1;
    if (cur.length >= limit || (cur.length > 0 && curBytes + bytes > budget)) {
      flush();
    }
    cur.push(e);
    curBytes += bytes;
    if (e.lastmod && (!curLast || e.lastmod > curLast)) curLast = e.lastmod;
  }
  flush();
  return shards;
}

function renderNewsXml(
  items: { loc: string; date: string; title: string }[],
  language: string,
  publication: string,
): string {
  const body = items
    .map(
      (it) =>
        `<url><loc>${esc(it.loc)}</loc>` +
        `<news:news><news:publication>` +
        `<news:name>${esc(publication)}</news:name>` +
        `<news:language>${esc(language)}</news:language>` +
        `</news:publication>` +
        `<news:publication_date>${it.date}</news:publication_date>` +
        `<news:title>${esc(it.title)}</news:title>` +
        `</news:news></url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${body}
</urlset>`;
}

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {

    addFilter<SitemapPayload>(HOOKS.sitemapUrls, async (payload) => {
      const { base } = payload;
      // R532: the calendar the core labels lastmod in - the payload carries
      // the timezone the core already resolved, so the two cannot drift and
      // the plugin needs no extra settings read.
      const tz = payload.tz || "Asia/Shanghai";

      const postByLoc = new Map(
        payload.posts.map((p) => [`${base}${p.url}`, p]),
      );
      const pageByLoc = new Map(
        payload.pages.map((p) => [`${base}${p.url}`, p]),
      );
      const catLocs = new Set(payload.categories.map((c) => `${base}${c.url}`));
      const tagLocs = new Set(payload.tags.map((t) => `${base}${t.url}`));
      const excludes = lines(settings.excludeKeywords);

      const cf = (CHANGEFREQS.has(settings.changefreq)
        ? settings.changefreq
        : "weekly") as SitemapChangefreq;

      const collectImages = (
        featured: string | null,
        blocks: Block[] | null,
      ): string[] | undefined => {
        if (!settings.images) return undefined;
        const raw: string[] = [];
        if (settings.imageFeatured && featured) raw.push(featured);
        if (settings.imageContent) raw.push(...contentImages(blocks));
        const abs = [...new Set(raw)]
          .map((u) => absolute(u, base))
          .filter((u) => /^https?:\/\//i.test(u));
        return abs.length ? abs : undefined;
      };

      const next: SitemapEntry[] = [];
      for (const e of payload.entries) {
        if (!settings.includePages && pageByLoc.has(e.loc)) continue;
        if (!settings.includeCategories && catLocs.has(e.loc)) continue;
        if (!settings.includeTags && tagLocs.has(e.loc)) continue;
        if (excludes.some((k) => e.loc.includes(k))) continue;

        const post = postByLoc.get(e.loc);
        const page = pageByLoc.get(e.loc);
        if (post) {
          const src =
            settings.lastmodSource === "published"
              ? (post.publishedAt ?? post.updatedAt)
              : (post.updatedAt ?? post.publishedAt);
          const d = siteDay(src, tz);
          if (d) e.lastmod = d;
          e.changefreq = cf;
          e.priority = settings.postPriority;
          const imgs = collectImages(post.featuredImage, post.content);
          if (imgs) e.images = imgs;
        } else if (page) {
          const d = siteDay(page.updatedAt ?? page.publishedAt, tz);
          if (d) e.lastmod = d;
          e.changefreq = cf;
          e.priority = settings.pagePriority;
          const imgs = collectImages(page.featuredImage, page.content);
          if (imgs) e.images = imgs;
        }
        next.push(e);
      }

      const existing = new Set(next.map((e) => e.loc));
      for (const raw of lines(settings.extraUrls)) {
        const loc = absolute(raw, base);
        if (!/^https?:\/\//i.test(loc) || existing.has(loc)) continue;
        if (excludes.some((k) => loc.includes(k))) continue;
        next.push({ loc, changefreq: "monthly", priority: "0.5" });
        existing.add(loc);
      }

      payload.entries = next;
      return payload;
    });

    addFilter<SitemapDocumentPayload>(
      HOOKS.sitemapDocument,
      async (payload) => {
        const sp = payload.searchParams;
        const XML_TYPE = "application/xml; charset=utf-8";

        if (sp.get("kind") === "news") {
          if (settings.newsEnabled) {
            const site = await getSettings();
            const hours = Math.max(1, Number(settings.newsHours) || 48);
            const cutoff = Date.now() - hours * 3_600_000;
            const now = Date.now();
            const excludes = lines(settings.excludeKeywords);
            const items: { loc: string; date: string; title: string }[] = [];
            for (const p of payload.posts) {
              if (!p.publishedAt) continue;
              const t = p.publishedAt.getTime();

              if (t > now || t < cutoff) continue;
              const loc = `${payload.base}${p.url}`;
              if (excludes.some((k) => loc.includes(k))) continue;
              items.push({
                loc,
                date: p.publishedAt.toISOString(),
                title: p.title,
              });
            }

            items.sort((a, b) => b.date.localeCompare(a.date));
            payload.doc = {
              contentType: XML_TYPE,
              xml: renderNewsXml(
                items,
                settings.newsLanguage || "zh-CN",
                site.siteTitle || "oboext",
              ),
            };
          }
          return payload;
        }

        const shards = buildShards(
          payload.entries,
          settings.shardMaxUrls,
          settings.shardMaxMb * 1024 * 1024,
        );

        const partRaw = sp.get("part");
        if (partRaw !== null) {
          if (/^[1-9]\d*$/.test(partRaw)) {
            const shard = shards[Number(partRaw) - 1];
            if (shard) {
              payload.doc = {
                contentType: XML_TYPE,
                xml: renderSitemapUrlset(shard.entries),
              };
            }
          }
          return payload;
        }

        if (shards.length > 1) {
          payload.doc = {
            contentType: XML_TYPE,
            xml: renderSitemapIndex(
              shards.map((s, i) => ({
                loc: `${payload.base}/sitemap.xml?part=${i + 1}`,
                lastmod: s.lastmod,
              })),
            ),
          };
        }
        return payload;
      },
    );

    addFilter<RobotsPayload>(HOOKS.robotsRules, (payload) => {
      if (!settings.newsEnabled) return payload;

      if (payload.lines.some((l) => l.trim() === "Disallow: /")) {
        return payload;
      }
      const decl = `Sitemap: ${payload.base}/sitemap.xml?kind=news`;
      if (!payload.lines.includes(decl)) payload.lines.push("", decl);
      return payload;
    });
  },
});
