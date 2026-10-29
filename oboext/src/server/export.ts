import { rawQuery } from "./db.js";
import { listPosts, listCategories, listTags, getSettings } from "./queries.js";
import { adminListPages, adminGetPage } from "./pages.js";
import type { SessionUser } from "./auth.js";
import type { Block } from "./schema.js";

export const EXPORT_SCOPES = ["posts", "pages", "comments", "taxonomies", "settings"] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

async function paginate<T>(
  fetchPage: (offset: number) => Promise<{ items: T[]; total: number }>,
  size: number,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += size) {
    const { items, total } = await fetchPage(offset);
    all.push(...items);
    if (items.length === 0 || all.length >= total) break;
  }
  return all;
}

function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading":
          return `${"#".repeat(b.level)} ${b.text}`;
        case "paragraph":
          return b.text;
        case "image":
          return `![${b.alt ?? ""}](${b.url})${b.caption ? `\n\n*${b.caption}*` : ""}`;
        case "quote":
          return `> ${b.text.split(/\r?\n/).join("\n> ")}${b.cite ? `\n>\n> — ${b.cite}` : ""}`;
        case "code":
          return `\`\`\`${b.language ?? ""}\n${b.code}\n\`\`\``;
        case "list":
          return b.items
            .map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`))
            .join("\n");
        case "divider":
          return "---";
        case "html":
          return b.html;
      }
    })
    .join("\n\n");
}

const oneLine = (v: unknown) => String(v).replace(/\r?\n/g, " ").trim();

// Custom fields arrive as an object map from posts and as either map or
// [{key,value}] from pages; both are valid import input, so one JSON line
// round-trips either shape without inventing a second dialect.
function jsonObject(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  return Object.keys(v as object).length ? JSON.stringify(v) : "";
}

function entryMeta(e: Record<string, unknown>): string {
  const lines = [
    `- 别名：${String(e.slug ?? "")}`,
    `- 状态：${String(e.status ?? "")}`,
    e.createdAt ? `- 创建时间：${new Date(e.createdAt as string).toISOString()}` : null,
    e.updatedAt ? `- 更新时间：${new Date(e.updatedAt as string).toISOString()}` : null,
    // A migration must keep the original publish date and the SEO/cover fields:
    // without them every imported post lands at "now" and loses its search
    // snippet. Caps live in import.ts (normalizeItem).
    e.publishedAt ? `- 发布时间：${new Date(e.publishedAt as string).toISOString()}` : null,
    e.excerpt ? `- 摘要：${oneLine(e.excerpt)}` : null,
    e.featuredImage ? `- 封面：${oneLine(e.featuredImage)}` : null,
    e.seoTitle ? `- SEO 标题：${oneLine(e.seoTitle)}` : null,
    e.seoDescription ? `- SEO 描述：${oneLine(e.seoDescription)}` : null,
    e.seoKeywords ? `- SEO 关键词：${oneLine(e.seoKeywords)}` : null,
    // Defaults (open / standard) are omitted so a partial file never forces
    // them onto an overwritten entry; JSON export still carries them verbatim.
    e.commentStatus === "closed" ? `- 评论状态：closed` : null,
    e.format && e.format !== "standard" ? `- 文章形式：${oneLine(e.format)}` : null,
    jsonObject(e.formatMeta) ? `- 形式字段：${jsonObject(e.formatMeta)}` : null,
    e.template ? `- 模板：${oneLine(e.template)}` : null,
    e.parentSlug ? `- 父页面：${oneLine(e.parentSlug)}` : null,
    typeof e.order === "number" ? `- 排序：${e.order}` : null,
    jsonObject(e.metas ?? e.metaList) ? `- 自定义字段：${jsonObject(e.metas ?? e.metaList)}` : null,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

function toMarkdown(data: Record<string, unknown>): string {
  const out: string[] = [
    "# Oboext 内容导出",
    "",
    `> 导出时间：${String(data.exportedAt)}`,
    "",
  ];

  const list = data.posts as Record<string, unknown>[] | undefined;
  if (list) {
    out.push("# 文章", "");
    for (const p of list) {
      const cats = ((p.categories as { name: string }[]) ?? []).map((c) => c.name).join("、");
      const tags = ((p.tags as { name: string }[]) ?? []).map((t) => t.name).join("、");
      out.push(
        ...[
          "<!-- oboext:post:start -->",
          `## ${String(p.title)}`,
          "",
          entryMeta(p),
          cats ? `- 分类：${cats}` : null,
          tags ? `- 标签：${tags}` : null,
          "",
          blocksToMarkdown((p.content as Block[]) ?? []),
          "<!-- oboext:post:end -->",
          "",
        ].filter((l): l is string => l !== null),
      );
    }
  }

  const pages = data.pages as Record<string, unknown>[] | undefined;
  if (pages) {
    out.push("# 独立页面", "");
    for (const p of pages) {
      out.push(
        "<!-- oboext:page:start -->",
        `## ${String(p.title)}`,
        "",
        entryMeta(p),
        "",
        blocksToMarkdown((p.content as Block[]) ?? []),
        "<!-- oboext:page:end -->",
        "",
      );
    }
  }

  const tax = data.taxonomies as
    | { categories: { name: string; slug: string }[]; tags: { name: string; slug: string }[] }
    | undefined;
  if (tax) {
    out.push("# 分类与标签", "", "## 分类", "");
    for (const c of tax.categories) out.push(`- ${c.name}（${c.slug}）`);
    out.push("", "## 标签", "");
    for (const t of tax.tags) out.push(`- ${t.name}（${t.slug}）`);
    out.push("");
  }

  const comments = data.comments as Record<string, unknown>[] | undefined;
  if (comments) {
    out.push("# 评论", "");
    for (const c of comments) {
      out.push(
        `- [${String(c.status)}] ${String(c.authorName ?? "")} 于 ${new Date(
          c.createdAt as string,
        ).toISOString()} 评论 ${String(c.postType ?? "")}#${String(c.postId ?? "")}：${String(
          c.content ?? "",
        ).replace(/\r?\n/g, " ")}`,
      );
    }
    out.push("");
  }

  const settings = data.settings as Record<string, unknown> | undefined;
  if (settings) {
    out.push("# 站点设置", "");
    for (const [k, v] of Object.entries(settings)) {
      out.push(`- **${k}**：${v === null || v === undefined ? "" : String(v)}`);
    }
  }

  return out.filter((l) => l !== null).join("\n");
}

export async function buildExportData(
  user: SessionUser | null,
  scopes: ExportScope[],
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {
    tool: "oboext",
    version: 1,
    exportedAt: new Date().toISOString(),
  };
  if (scopes.includes("posts")) {
    const rows = await paginate((offset) => listPosts({ limit: 100, offset, full: true }), 100);
    // R276: translation pairing travels by SLUG, not by id — the numeric
    // translationOf means nothing on another install (same rule pages use
    // for parentSlug). The export rewrites the id to the original's slug;
    // locale rides along as-is. Unpaired posts keep translationOf absent.
    const slugById = new Map(rows.map((p) => [p.id, p.slug]));
    data.posts = rows.map((p) => {
      if (!p.translationOf) return p;
      const originalSlug = slugById.get(p.translationOf);
      if (!originalSlug) return { ...p, translationOf: undefined };
      return { ...p, translationOf: undefined, translationOfSlug: originalSlug };
    });
  }
  if (scopes.includes("pages")) {
    const rows = await paginate((offset) => adminListPages(user, { limit: 100, offset }), 100);
    // Hierarchy is exported by slug: the numeric parentId means nothing in the
    // receiving install. A parent outside this export simply has no link.
    const slugById = new Map(rows.map((p) => [p.id, p.slug]));
    data.pages = await Promise.all(
      rows.map(async (p) => {
        const detail = await adminGetPage(user, p.id);
        const parentSlug = detail.parentId ? slugById.get(detail.parentId) : undefined;
        return parentSlug ? { ...detail, parentSlug } : detail;
      }),
    );
  }
  if (scopes.includes("comments")) {

    // parentId/authorEmail/authorUrl are what WXR needs to keep a thread and a
    // guest identity intact; the address is exported, the IP never is.
    data.comments = await rawQuery<Record<string, unknown>>(
      `SELECT id, post_id AS "postId", post_type AS "postType", parent_id AS "parentId",
              status, author_name AS "authorName", author_email AS "authorEmail",
              author_url AS "authorUrl", content, created_at AS "createdAt"
         FROM comments ORDER BY id`,
    );
  }
  if (scopes.includes("taxonomies")) {
    data.taxonomies = {
      categories: await listCategories(),
      tags: await listTags(),
    };
  }
  if (scopes.includes("settings")) {
    data.settings = await getSettings();
  }
  return data;
}

export function exportToMarkdown(data: Record<string, unknown>): string {
  return toMarkdown(data);
}

// ---------------------------------------------------------------------- WXR
// WordPress's eXtended RSS is the one exchange dialect every blog engine
// reads, so an Oboext → WXR export is the exit door a migration needs. Only
// WordPress-side conventions that survive a round trip are emitted: ids are
// regenerated (the importer resolves them back through its pre-passes), and
// plugin-specific postmeta uses the Yoast keys the importer already reads.

const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xmlText(v: unknown): string {
  return String(v ?? "").replace(XML_INVALID, "").replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

/** Titles and bodies travel in CDATA; a literal `]]>` would close it early. */
function xmlCdata(v: unknown): string {
  return `<![CDATA[${String(v ?? "").replace(XML_INVALID, "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

const WXR_POST_FORMATS = new Set([
  "aside", "quote", "link", "image", "gallery", "video", "audio", "status",
]);

/** Structured blocks → the HTML WordPress stores in post_content. */
function blocksToHtml(blocks: Block[]): string {
  return (blocks ?? [])
    .map((b) => {
      switch (b.type) {
        case "heading":
          return `<h${b.level}>${xmlText(b.text)}</h${b.level}>`;
        case "paragraph":
          return `<p>${xmlText(b.text).replace(/\r?\n/g, "<br />")}</p>`;
        case "image": {
          const img = `<img src="${xmlText(b.url)}" alt="${xmlText(b.alt ?? "")}" />`;
          // A bare <img> is what the importer turns back into an image block;
          // a caption needs the figure wrapper (returns as an html block).
          return b.caption ? `<figure>${img}<figcaption>${xmlText(b.caption)}</figcaption></figure>` : img;
        }
        case "quote": {
          const extra = `${b.title ? `<footer>${xmlText(b.title)}</footer>` : ""}${b.cite ? `<cite>${xmlText(b.cite)}</cite>` : ""}`;
          return extra
            ? `<blockquote><p>${xmlText(b.text).replace(/\r?\n/g, "<br />")}</p>${extra}</blockquote>`
            : `<blockquote>${xmlText(b.text)}</blockquote>`;
        }
        case "code": {
          const cls = b.language ? ` class="language-${xmlText(b.language)}"` : "";
          return `<pre><code${cls}>${xmlText(b.code)}</code></pre>`;
        }
        case "list": {
          const tag = b.ordered ? "ol" : "ul";
          return `<${tag}>${b.items.map((it) => `<li>${xmlText(it)}</li>`).join("")}</${tag}>`;
        }
        case "divider":
          return "<hr />";
        case "html":
          return String(b.html ?? "");
      }
    })
    .join("\n");
}

function wxrZone(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (!name) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return name;
  } catch {
    return "UTC";
  }
}

/** WXR wants `YYYY-MM-DD HH:MM:SS`; `gmt` is UTC, `local` uses the site zone. */
function wxrStamp(value: unknown, timeZone: string, utc = false): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: utc ? "UTC" : timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

function absoluteUrl(raw: string, site: string): string {
  try {
    return new URL(raw, site.endsWith("/") ? site : site + "/").href;
  } catch {
    return raw;
  }
}

const wxrStatusOut = (status: string) =>
  status === "published" ? "publish" : status === "draft" ? "draft" : "private";

function metaPair(key: string, value: unknown): string {
  return `    <wp:postmeta>\n      <wp:meta_key>${xmlCdata(key)}</wp:meta_key>\n      <wp:meta_value>${xmlCdata(value)}</wp:meta_value>\n    </wp:postmeta>\n`;
}

function entryMetas(p: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  const raw = p.metas ?? p.metaList;
  if (Array.isArray(raw)) {
    for (const m of raw as { key?: unknown; value?: unknown }[]) {
      const key = String(m?.key ?? "").trim();
      if (key) out.push([key, String(m?.value ?? "")]);
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const key = k.trim();
      if (key) out.push([key, String(v ?? "")]);
    }
  }
  return out;
}

export function exportToWxr(data: Record<string, unknown>, opts: { siteUrl: string }): string {
  const site = opts.siteUrl.replace(/\/+$/, "");
  const settings = (data.settings ?? {}) as Record<string, unknown>;
  const zone = wxrZone(settings.timezone);
  const posts = (data.posts as Record<string, unknown>[] | undefined) ?? [];
  const pages = (data.pages as Record<string, unknown>[] | undefined) ?? [];
  // Comments ride inside the item they belong to — that is the only place
  // WordPress looks for them. Comments whose target is not in this export are
  // dropped rather than promoted to orphans.
  const commentsByTarget = new Map<string, Record<string, unknown>[]>();
  for (const c of (data.comments as Record<string, unknown>[] | undefined) ?? []) {
    const key = `${String(c.postType ?? "post")}:${Number(c.postId)}`;
    const list = commentsByTarget.get(key);
    if (list) list.push(c);
    else commentsByTarget.set(key, [c]);
  }
  const wxrComment = (c: Record<string, unknown>, siblings: Set<number>): string => {
    const approved = c.status === "published" ? "1" : c.status === "spam" ? "spam" : "0";
    const parent = Number(c.parentId);
    return `    <wp:comment>
      <wp:comment_id>${Number(c.id)}</wp:comment_id>
      <wp:comment_author>${xmlCdata(c.authorName ?? "")}</wp:comment_author>
      <wp:comment_author_email>${xmlCdata(c.authorEmail ?? "")}</wp:comment_author_email>
      <wp:comment_author_url>${xmlCdata(c.authorUrl ?? "")}</wp:comment_author_url>
      <wp:comment_date>${wxrStamp(c.createdAt, zone)}</wp:comment_date>
      <wp:comment_date_gmt>${wxrStamp(c.createdAt, zone, true)}</wp:comment_date_gmt>
      <wp:comment_content>${xmlCdata(c.content ?? "")}</wp:comment_content>
      <wp:comment_approved>${approved}</wp:comment_approved>
      <wp:comment_type><![CDATA[comment]]></wp:comment_type>
      <wp:comment_parent>${siblings.has(parent) ? parent : 0}</wp:comment_parent>
    </wp:comment>\n`;
  };
  const exportedAt = data.exportedAt instanceof Date ? data.exportedAt : new Date(String(data.exportedAt ?? ""));
  const now = Number.isFinite(exportedAt.getTime()) ? exportedAt : new Date();

  let nextId = 1;
  const postWpIds = new Map<number, number>();
  const pageWpIds = new Map<number, number>();
  for (const p of posts) postWpIds.set(Number(p.id), nextId++);
  for (const p of pages) pageWpIds.set(Number(p.id), nextId++);

  // Covers become attachment rows so WordPress keeps _thumbnail_id pointing at
  // a real file; one attachment per distinct URL, shared by every post using it.
  const attachments = new Map<string, number>();
  const attachId = (raw: unknown): number | null => {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    const url = absoluteUrl(value, site);
    if (!attachments.has(url)) attachments.set(url, nextId++);
    return attachments.get(url)!;
  };
  for (const p of [...posts, ...pages]) attachId(p.featuredImage);

  const authors = new Map<string, { id: number; name: string; email: string }>();
  for (const p of posts) {
    const a = (p.author ?? null) as { id?: unknown; name?: unknown; email?: unknown } | null;
    const name = String(a?.name ?? "").trim() || String(settings.siteTitle ?? "admin");
    if (!authors.has(name)) {
      authors.set(name, {
        id: Number(a?.id) || authors.size + 1,
        name,
        email: String(a?.email ?? ""),
      });
    }
  }
  const creatorOf = (p: Record<string, unknown>) =>
    String((p.author as { name?: unknown } | null)?.name ?? "").trim() ||
    [...authors.keys()][0] ||
    String(settings.siteTitle ?? "admin");

  const item = (p: Record<string, unknown>, type: "post" | "page"): string => {
    const isPost = type === "post";
    const wpId = (isPost ? postWpIds : pageWpIds).get(Number(p.id)) ?? 0;
    const status = String(p.status ?? "draft");
    const slug = String(p.slug ?? "");
    const publishedAt = p.publishedAt ?? p.createdAt ?? now;
    const published = publishedAt instanceof Date ? publishedAt : new Date(String(publishedAt));
    const link = String(p.url ?? "").startsWith("http")
      ? String(p.url)
      : absoluteUrl(String(p.url ?? `/${slug}`), site);

    const taxonomy: string[] = [];
    if (isPost) {
      for (const c of (p.categories as { name?: unknown; slug?: unknown }[] | undefined) ?? []) {
        const name = String(c.name ?? "").trim();
        if (name) taxonomy.push(`    <category domain="category" nicename="${xmlText(c.slug ?? name)}">${xmlCdata(name)}</category>\n`);
      }
      for (const t of (p.tags as { name?: unknown; slug?: unknown }[] | undefined) ?? []) {
        const name = String(t.name ?? "").trim();
        if (name) taxonomy.push(`    <category domain="post_tag" nicename="${xmlText(t.slug ?? name)}">${xmlCdata(name)}</category>\n`);
      }
      // "standard" is WordPress's implicit default; emitting the term would
      // make a round trip come back with a format where there was none.
      const format = String(p.format ?? "standard").toLowerCase();
      if (format !== "standard" && WXR_POST_FORMATS.has(format)) {
        taxonomy.push(`    <category domain="post_format" nicename="post-format-${format}">${xmlCdata(format)}</category>\n`);
      }
    }

    const thumbId = attachId(p.featuredImage);
    const meta: string[] = [];
    if (thumbId) meta.push(metaPair("_thumbnail_id", String(thumbId)));
    if (p.seoTitle) meta.push(metaPair("_yoast_wpseo_title", p.seoTitle));
    if (p.seoDescription) meta.push(metaPair("_yoast_wpseo_metadesc", p.seoDescription));
    if (p.seoKeywords) meta.push(metaPair("_yoast_wpseo_focuskw", p.seoKeywords));
    // WordPress has no "archived"; the status marker keeps the distinction for
    // an Oboext → Oboext move while WordPress still sees a private post.
    if (status !== "published" && status !== "draft") meta.push(metaPair("oboext_status", status));
    for (const [key, value] of entryMetas(p)) meta.push(metaPair(key, value));

    const parent = type === "page" && p.parentId ? pageWpIds.get(Number(p.parentId)) ?? 0 : 0;
    const order = type === "page" ? Number(p.order ?? 0) || 0 : 0;
    const own = commentsByTarget.get(`${type}:${Number(p.id)}`) ?? [];
    const siblingIds = new Set(own.map((c) => Number(c.id)));
    const commentXml = own.map((c) => wxrComment(c, siblingIds)).join("");

    return `  <item>
    <title>${xmlCdata(p.title)}</title>
    <link>${xmlText(link)}</link>
    <pubDate>${Number.isFinite(published.getTime()) ? published.toUTCString() : now.toUTCString()}</pubDate>
    <dc:creator>${xmlCdata(creatorOf(p))}</dc:creator>
    <guid isPermaLink="false">${xmlCdata(`oboext:${type}:${p.id}`)}</guid>
    <description></description>
    <content:encoded>${xmlCdata(blocksToHtml((p.content as Block[]) ?? []))}</content:encoded>
    <excerpt:encoded>${xmlCdata(p.excerpt ?? "")}</excerpt:encoded>
    <wp:post_id>${wpId}</wp:post_id>
    <wp:post_date>${wxrStamp(publishedAt, zone)}</wp:post_date>
    <wp:post_date_gmt>${wxrStamp(publishedAt, zone, true)}</wp:post_date_gmt>
    <wp:comment_status>${p.commentStatus === "closed" ? "closed" : "open"}</wp:comment_status>
    <wp:ping_status>closed</wp:ping_status>
    <wp:post_name>${xmlCdata(slug)}</wp:post_name>
    <wp:status>${wxrStatusOut(status)}</wp:status>
    <wp:post_parent>${parent}</wp:post_parent>
    <wp:menu_order>${order}</wp:menu_order>
    <wp:post_type>${type}</wp:post_type>
    <wp:post_password></wp:post_password>
    <wp:is_sticky>${p.pinned ? 1 : 0}</wp:is_sticky>
${taxonomy.join("")}${meta.join("")}${commentXml}  </item>\n`;
  };

  const attachmentItems = [...attachments].map(([url, id]) => {
    const file = url.split("/").pop() || "attachment";
    let title = file;
    try {
      title = decodeURIComponent(file);
    } catch {
      /* malformed escapes stay verbatim */
    }
    return `  <item>
    <title>${xmlCdata(title)}</title>
    <link>${xmlText(url)}</link>
    <pubDate>${now.toUTCString()}</pubDate>
    <dc:creator>${xmlCdata([...authors.keys()][0] ?? String(settings.siteTitle ?? "admin"))}</dc:creator>
    <guid isPermaLink="false">${xmlCdata(url)}</guid>
    <content:encoded><![CDATA[]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_date>${wxrStamp(now, zone)}</wp:post_date>
    <wp:post_date_gmt>${wxrStamp(now, zone, true)}</wp:post_date_gmt>
    <wp:comment_status>closed</wp:comment_status>
    <wp:ping_status>closed</wp:ping_status>
    <wp:post_name>${xmlCdata(title.replace(/\.[^.]+$/, ""))}</wp:post_name>
    <wp:status>inherit</wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>0</wp:menu_order>
    <wp:post_type>attachment</wp:post_type>
    <wp:post_password></wp:post_password>
    <wp:is_sticky>0</wp:is_sticky>
    <wp:attachment_url>${xmlCdata(url)}</wp:attachment_url>
${metaPair("_wp_attached_file", title)}  </item>\n`;
  });

  const authorItems = [...authors.values()].map(
    (a) => `  <wp:author>
    <wp:author_id>${a.id}</wp:author_id>
    <wp:author_login>${xmlCdata(a.name)}</wp:author_login>
    <wp:author_email>${xmlCdata(a.email)}</wp:author_email>
    <wp:author_display_name>${xmlCdata(a.name)}</wp:author_display_name>
    <wp:author_first_name></wp:author_first_name>
    <wp:author_last_name></wp:author_last_name>
  </wp:author>\n`,
  );

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wfw="http://wellformedweb.org/CommentAPI/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">`,
    `<channel>`,
    `  <title>${xmlCdata(settings.siteTitle ?? "Oboext")}</title>`,
    `  <link>${xmlText(site)}</link>`,
    `  <description>${xmlCdata(settings.siteDescription ?? "")}</description>`,
    `  <pubDate>${now.toUTCString()}</pubDate>`,
    `  <language>${xmlText(settings.locale ?? settings.language ?? "zh-CN")}</language>`,
    `  <generator>Oboext</generator>`,
    `  <wp:wxr_version>1.2</wp:wxr_version>`,
    `  <wp:base_site_url>${xmlText(site)}</wp:base_site_url>`,
    `  <wp:base_blog_url>${xmlText(site)}</wp:base_blog_url>`,
    authorItems.join("").trimEnd(),
    ...posts.map((p) => item(p, "post")),
    ...pages.map((p) => item(p, "page")),
    ...attachmentItems,
    `</channel>`,
    `</rss>`,
    ``,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
