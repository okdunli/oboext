// Content import — the counterpart of export.ts. Three dialects:
//   JSON      the Oboext export envelope ({tool:"oboext", version:1, posts?, pages?})
//   Markdown  the dialect export.ts itself writes (## title + "- 别名：…" meta),
//             plus generic markdown (first "# title" or "未命名导入")
//   WXR       a WordPress eXtended RSS export (posts, pages, categories, tags)
// Import goes through createPost/createPage/updatePost/updatePage, so shape
// validation, slug uniquifying, revision snapshots and cache invalidation all
// come from the normal write path.
// WXR comments are the one exception: they are appended to the post/page row
// only after it exists, because a historical comment must keep its original
// author, status and timestamp — none of which the public comment path allows.
// Taxonomies travel with the item: names are matched against the live terms
// (case-insensitive, then created when absent) so an export→import round trip
// and a WordPress migration both keep their category/tag assignments.
import crypto from "node:crypto";
import { db, rawQuery } from "./db.js";
import {
  posts,
  pages as pagesTable,
  comments as commentsTable,
  users as usersTable,
} from "./schema.js";
import type { Block } from "./schema.js";
import type { SessionUser } from "./auth.js";
import { hashPassword } from "./auth.js";
import { ServiceError } from "./errors.js";
import { createLogger } from "./logger.js";
import { createCategory, createPost, createTag, slugify, updatePost } from "./admin.js";
import { createPage, updatePage } from "./pages.js";
import { listCategories, listTags } from "./queries.js";
import { invalidateContentCaches } from "./cache.js";

const log = createLogger("import");

export type ImportKind = "post" | "page";
export type ImportPolicy = "skip" | "overwrite";
export type PostStatus = "draft" | "published" | "archived";

export const IMPORT_MAX_ITEMS = 200;
// WordPress exports carry media registrations and comments alongside content,
// so the same 200-item budget needs more bytes than a hand-written Markdown file.
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const IMPORT_MAX_BLOCKS = 2000;
// A hostile file cannot turn one post into an unbounded insert storm.
export const IMPORT_MAX_COMMENTS = 100;
export const IMPORT_MAX_COMMENT_CHARS = 5000;
// A foreign file can name a different author on every item; without a cap it
// would turn one import into an account-factory.
export const IMPORT_MAX_AUTHORS = 50;
// A ZIP bundle is inflated entry by entry; one blog post beyond 2MB of Markdown
// is a red flag, and the total cap bounds a deflate bomb well below RAM limits.
export const IMPORT_ZIP_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
export const IMPORT_ZIP_MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export type ImportComment = {
  authorName: string;
  authorEmail?: string;
  authorUrl?: string;
  content: string;
  status: "published" | "pending" | "spam";
  createdAt?: string;
  /** Position of the parent inside the same item's comment list. */
  parentIndex?: number;
};

export type NormalizedItem = {
  title: string;
  slug: string;
  status: PostStatus;
  excerpt: string;
  content: Block[];
  publishedAt?: string;
  featuredImage?: string;
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
  /** Custom fields (post_metas/page_metas), full-set replace like the admin form. */
  metas?: { key: string; value: string }[];
  commentStatus?: "open" | "closed";
  format?: string;
  formatMeta?: Record<string, string>;
  template?: string;
  /** Parent page referenced by slug: the only key that survives a cross-site move. */
  parentSlug?: string;
  /** R276: content language (i18n LOCALES); rides the item verbatim. */
  locale?: string;
  /** R276: the original's slug (export rewrites the id). Resolved in a second pass. */
  translationOfSlug?: string;
  /** WordPress `wp:is_sticky` / front-matter `sticky`: pin to the top of lists. */
  pinned?: boolean;
  /** WXR comments; appended only when the item is newly created. */
  comments?: ImportComment[];
  /** WXR `dc:creator` / front-matter `author`: the byline the file carries. */
  creator?: string;
  /** `wp:author_email` of that byline, so a moved account keeps its address. */
  creatorEmail?: string;
  categories: string[];
  tags: string[];
};

export type ItemIssue = { index: number; title: string; reason: string };

export type KindPlan = {
  total: number;
  valid: NormalizedItem[];
  issues: ItemIssue[];
  conflicts: { slug: string; title: string; existingId: number }[];
  creates: number;
  comments: number;
};

export type ImportPlan = {
  format: "json" | "markdown" | "wxr" | "zip";
  posts: KindPlan;
  pages: KindPlan;
  bundle?: { files: number; skipped: BundleSkip[] };
};

const STATUS_ALIASES: Record<string, PostStatus> = {
  draft: "draft",
  published: "published",
  archived: "archived",
  草稿: "draft",
  已发布: "published",
  发布: "published",
  归档: "archived",
};

export function normalizeStatus(raw: unknown): PostStatus | null {
  if (raw == null || raw === "") return null;
  const key = String(raw).trim().toLowerCase();
  return STATUS_ALIASES[key] ?? STATUS_ALIASES[String(raw).trim()] ?? null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Category/tag names from any dialect: bare strings or {name} objects. */
function termNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const name = typeof v === "string" ? v : str((v as { name?: unknown } | null)?.name);
    const trimmed = name.trim().slice(0, 100);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 50) break;
  }
  return out;
}

// One markdown line group → blocks. Pure; the dialect mirrors export.ts's
// blocksToMarkdown so an export→import round trip is lossless.
export function markdownBodyToBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const push = (b: Block) => {
    if (blocks.length < IMPORT_MAX_BLOCKS) blocks.push(b);
  };
  let para: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let html: string[] = [];
  const flushPara = () => {
    if (para.length) {
      push({ id: `imp-${blocks.length}`, type: "paragraph", text: para.join("\n") });
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      push({ id: `imp-${blocks.length}`, type: "quote", text: quote.join("\n") });
      quote = [];
    }
  };
  const flushList = () => {
    if (list) {
      push({ id: `imp-${blocks.length}`, type: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  const flushHtml = () => {
    if (html.length) {
      push({ id: `imp-${blocks.length}`, type: "html", html: html.join("\n") });
      html = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushList();
    flushHtml();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```([a-zA-Z0-9+#._-]*)\s*$/);
    if (fence) {
      flushAll();
      const lang = fence[1] || undefined;
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      push({ id: `imp-${blocks.length}`, type: "code", ...(lang ? { language: lang } : {}), code: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      push({
        id: `imp-${blocks.length}`,
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
      });
      continue;
    }
    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    if (image) {
      flushAll();
      const next = lines[i + 1] ?? "";
      const cap = next.match(/^\*([^*]+)\*\s*$/);
      push({
        id: `imp-${blocks.length}`,
        type: "image",
        url: image[2],
        alt: image[1] || undefined,
        ...(cap ? { caption: cap[1] } : {}),
      });
      if (cap) i++;
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      flushAll();
      push({ id: `imp-${blocks.length}`, type: "divider" });
      continue;
    }
    if (/^>/.test(line)) {
      flushPara();
      flushList();
      flushHtml();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      flushQuote();
      flushHtml();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ? ul[1] : ol![1]).trim());
      continue;
    }
    if (/^\s*<[a-zA-Z!/]/.test(line)) {
      flushPara();
      flushQuote();
      flushList();
      html.push(line);
      continue;
    }
    if (line.trim() === "") {
      flushAll();
      continue;
    }
    flushQuote();
    flushList();
    flushHtml();
    para.push(line);
  }
  flushAll();
  return blocks;
}

const META_RE = /^[-*]\s*(别名|状态|摘要|分类|标签|发布时间|创建时间|更新时间|封面|评论状态|文章形式|形式字段|模板|父页面|排序|自定义字段|SEO\s*(?:标题|描述|关键词))\s*[：:]\s*(.*)$/;

// export.ts joins names with 、; a hand-edited file may use any common separator.
function splitTermNames(raw: string): string[] {
  return raw
    .split(/[、,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ------------------------------------------------------------ front matter
// Hugo / Hexo / Jekyll / Obsidian all put metadata in a leading YAML block.
// Only the flat subset those tools actually emit is read: scalars, quoted
// strings, inline [a, b] lists and block `- item` lists. Nested maps are not
// part of any post header worth migrating, and a block that holds no
// `key: value` line is a Markdown thematic break, not metadata.
type FrontMatter = { meta: Record<string, string>; lists: Record<string, string[]>; end: number };

const FRONT_KEY_RE = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*(.*)$/;
const FRONT_TRUE = /^(true|yes|on|1)$/i;
const FRONT_FALSE = /^(false|no|off|0)$/i;
const FRONT_STATUS: Record<string, PostStatus> = {
  draft: "draft",
  publish: "published",
  published: "published",
  private: "draft",
  archived: "archived",
  草稿: "draft",
  发布: "published",
  已发布: "published",
  归档: "archived",
};

function unquoteYaml(raw: string): string {
  const v = raw.trim();
  if (v.length < 2) return v;
  const quote = v[0];
  if ((quote === '"' || quote === "'") && v[v.length - 1] === quote) {
    const inner = v.slice(1, -1);
    return quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return v;
}

function yamlList(raw: string): string[] {
  const v = raw.trim();
  if (!v) return [];
  if (v.startsWith("[") && v.endsWith("]"))
    return v.slice(1, -1).split(",").map(unquoteYaml).filter(Boolean);
  return splitTermNames(unquoteYaml(v));
}

function parseFrontMatter(lines: string[]): FrontMatter | null {
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (lines[start]?.trim() !== "---") return null;
  let close = -1;
  for (let i = start + 1; i < Math.min(lines.length, start + 200); i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const meta: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let pairs = 0;
  for (let i = start + 1; i < close; i++) {
    const m = lines[i].match(FRONT_KEY_RE);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2].trim();
    if (!value) {
      const items: string[] = [];
      let j = i + 1;
      for (; j < close; j++) {
        const item = lines[j].match(/^\s*-\s+(.+)$/);
        if (!item) break;
        items.push(unquoteYaml(item[1]));
      }
      if (!items.length) continue;
      lists[key] = items;
      meta[key] = items.join(", ");
      pairs++;
      i = j - 1;
      continue;
    }
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const parts: string[] = [];
      let j = i + 1;
      for (; j < close; j++) {
        if (!/^\s+\S/.test(lines[j])) break;
        parts.push(lines[j].trim());
      }
      value = parts.join(value.startsWith(">") ? " " : "\n");
      i = j - 1;
    } else if (!/^["']/.test(value)) {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    const scalar = unquoteYaml(value);
    meta[key] = scalar;
    if (/^\[.*\]$/.test(scalar)) lists[key] = yamlList(scalar);
    pairs++;
  }
  // A pair-less `--- ... ---` is a horizontal rule around body text.
  if (!pairs) return null;
  return { meta, lists, end: close + 1 };
}

function frontGet(fm: FrontMatter, ...keys: string[]): string {
  for (const key of keys) {
    const value = fm.meta[key];
    if (value != null && value !== "") return value;
  }
  return "";
}

function frontTerms(fm: FrontMatter, ...keys: string[]): string[] {
  for (const key of keys) if (fm.lists[key]?.length) return fm.lists[key];
  for (const key of keys) {
    const value = fm.meta[key];
    if (value) return splitTermNames(value);
  }
  return [];
}

/** Returns which bucket the header asks for, so `layout: page` lands in pages. */
function applyFrontMatter(item: Record<string, unknown>, fm: FrontMatter): "post" | "page" {
  const title = frontGet(fm, "title");
  if (title) item.title = title;
  const slug = frontGet(fm, "slug");
  if (slug) item.slug = slug;
  const date = frontGet(fm, "date", "publishedat", "published_at", "pubdate", "publishdate");
  if (date) item.publishedAt = date;
  const status = frontGet(fm, "status").toLowerCase();
  const draft = frontGet(fm, "draft");
  const published = frontGet(fm, "published");
  if (FRONT_STATUS[status]) item.status = FRONT_STATUS[status];
  else if (FRONT_TRUE.test(draft) || FRONT_FALSE.test(published)) item.status = "draft";
  else if (FRONT_FALSE.test(draft) || FRONT_TRUE.test(published)) item.status = "published";
  const excerpt = frontGet(fm, "excerpt", "description", "summary");
  if (excerpt) item.excerpt = excerpt;
  const cover = frontGet(fm, "cover", "image", "featured_image", "featuredimage", "thumbnail");
  if (cover) item.featuredImage = cover;
  const keywords = frontTerms(fm, "keywords", "focus_keyword", "focuskeyphrase");
  if (keywords.length) item.seoKeywords = keywords.join(", ");
  const tags = frontTerms(fm, "tags");
  if (tags.length) item.tags = tags;
  const categories = frontTerms(fm, "categories", "category");
  if (categories.length) item.categories = categories;
  const comments = frontGet(fm, "comments", "comment_status").toLowerCase();
  if (FRONT_FALSE.test(comments) || comments === "closed") item.commentStatus = "closed";
  else if (FRONT_TRUE.test(comments) || comments === "open") item.commentStatus = "open";
  const layout = frontGet(fm, "layout", "type", "kind").toLowerCase();
  const author = frontGet(fm, "author", "authorname", "author_name", "nickname");
  if (author) item.creator = author;
  const kind = layout === "page" ? "page" : "post";
  if (kind === "post") {
    const sticky = frontGet(fm, "sticky", "pinned");
    if (FRONT_TRUE.test(sticky)) item.pinned = true;
    else if (FRONT_FALSE.test(sticky)) item.pinned = false;
  } else {
    // Hugo/Jekyll use weight for the same thing WordPress calls menu_order.
    const weight = frontGet(fm, "order", "weight", "menu_order", "menuorder");
    if (weight) item.order = weight;
  }
  return kind;
}

function applyMarkdownMeta(item: Record<string, unknown>, meta: Record<string, string>) {
  if (meta["别名"]) item.slug = meta["别名"];
  if (meta["状态"]) item.status = meta["状态"];
  if (meta["摘要"]) item.excerpt = meta["摘要"];
  if (meta["发布时间"]) item.publishedAt = meta["发布时间"];
  if (meta["封面"]) item.featuredImage = meta["封面"];
  // Hand-edited files follow both "SEO 标题" (the export spelling) and "SEO标题".
  const seo = (label: string) => meta[`SEO ${label}`] ?? meta[`SEO${label}`];
  const seoTitle = seo("标题");
  const seoDescription = seo("描述");
  const seoKeywords = seo("关键词");
  if (seoTitle) item.seoTitle = seoTitle;
  if (seoDescription) item.seoDescription = seoDescription;
  if (seoKeywords) item.seoKeywords = seoKeywords;
  if (meta["分类"]) item.categories = splitTermNames(meta["分类"]);
  if (meta["标签"]) item.tags = splitTermNames(meta["标签"]);
  if (meta["评论状态"]) item.commentStatus = meta["评论状态"];
  if (meta["文章形式"]) item.format = meta["文章形式"];
  if (meta["作者"]) item.creator = meta["作者"];
  if (meta["模板"]) item.template = meta["模板"];
  if (meta["排序"]) item.order = meta["排序"];
  if (meta["父页面"]) item.parentSlug = meta["父页面"];
  for (const [label, field] of [
    ["自定义字段", "metas"],
    ["形式字段", "formatMeta"],
  ] as const) {
    const raw = meta[label];
    if (!raw) continue;
    try {
      item[field] = JSON.parse(raw);
    } catch {
      item.metaError = `${label}必须是合法的 JSON 对象`;
    }
  }
}

// ------------------------------------------------------------ WXR / HTML
// A WordPress export carries block markup as HTML, not as the JSON block list
// this app stores. The converter below is deliberately structural-first: an
// element whose children are plain text becomes a real editable block, and
// anything richer (links, tables, figures, embeds) is kept verbatim as an
// `html` block. render.ts runs sanitizeHtml() on that block at output time,
// so imported markup never reaches a reader unfiltered.

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** XML text nodes in a WXR file are entity-escaped; CDATA is not. */
function decodeXmlEntities(input: string): string {
  const code = (n: number) => {
    try {
      return String.fromCodePoint(n);
    } catch {
      return "";
    }
  };
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => code(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => code(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|td|th)>/gi, "\n")
    .replace(/<[^>]*>/g, "");
}

function htmlToText(html: string): string {
  return decodeXmlEntities(stripTags(html))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanWxrHtml(html: string): string {
  return html
    .replace(/<!--\s*wp:[\s\S]*?-->/g, "")
    .replace(/<!--\s*\/wp:[\s\S]*?-->/g, "")
    .replace(/<!--\s*more\s*-->/gi, "")
    .replace(/<!--\s*nextpage\s*-->/gi, "");
}

/** True when an element's children carry their own markup (links, emphasis…). */
function hasMarkup(inner: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(inner.replace(/<br\s*\/?>/gi, ""));
}

function attrOf(raw: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(raw);
  return m ? decodeXmlEntities(m[2] ?? m[3] ?? "") : "";
}

function outerTag(chunk: string): { tag: string; inner: string } | null {
  const m = /^<([a-zA-Z][\w:-]*)\b[^>]*>([\s\S]*)<\/\1\s*>$/.exec(chunk);
  return m ? { tag: m[1].toLowerCase(), inner: m[2] } : null;
}

/** Split an HTML fragment into its top-level nodes, keeping markup intact. */
function splitTopLevel(html: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      const tail = html.slice(i);
      if (tail.trim()) chunks.push(tail);
      break;
    }
    if (lt > i) {
      const text = html.slice(i, lt);
      if (text.trim()) chunks.push(text);
    }
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (/^<\/[a-zA-Z]/.test(html.slice(lt, lt + 3))) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const open = /^<([a-zA-Z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(html.slice(lt));
    if (!open) {
      i = lt + 1;
      continue;
    }
    const tag = open[1].toLowerCase();
    const openEnd = lt + open[0].length;
    if (open[0].endsWith("/>") || VOID_TAGS.has(tag)) {
      chunks.push(html.slice(lt, openEnd));
      i = openEnd;
      continue;
    }
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    scan.lastIndex = openEnd;
    let depth = 1;
    let end = -1;
    for (let m = scan.exec(html); m; m = scan.exec(html)) {
      if (m[0].endsWith("/>")) continue;
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    if (end < 0) {
      chunks.push(html.slice(lt));
      break;
    }
    chunks.push(html.slice(lt, end));
    i = end;
  }
  return chunks;
}

export function htmlBodyToBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const push = (b: Block) => {
    if (blocks.length < IMPORT_MAX_BLOCKS) blocks.push(b);
  };
  const id = () => `wxr-${blocks.length}`;
  for (const raw of splitTopLevel(cleanWxrHtml(html))) {
    const chunk = raw.trim();
    if (!chunk) continue;
    if (!chunk.startsWith("<")) {
      const text = htmlToText(chunk);
      if (text) push({ id: id(), type: "paragraph", text });
      continue;
    }
    if (/^<hr\b[^>]*>$/i.test(chunk)) {
      push({ id: id(), type: "divider" });
      continue;
    }
    const img = /^<img\b([^>]*)>$/i.exec(chunk);
    if (img) {
      const url = attrOf(img[1], "src");
      if (url) {
        const alt = attrOf(img[1], "alt");
        push({ id: id(), type: "image", url, ...(alt ? { alt } : {}) });
      }
      continue;
    }
    const outer = outerTag(chunk);
    if (!outer) {
      push({ id: id(), type: "html", html: chunk });
      continue;
    }
    const { tag, inner } = outer;
    const plain = !hasMarkup(inner);
    if (/^h[1-6]$/.test(tag) && plain) {
      const level = Math.min(4, Number(tag[1])) as 1 | 2 | 3 | 4;
      const text = htmlToText(inner);
      if (text) push({ id: id(), type: "heading", level, text });
      continue;
    }
    if (tag === "p" && plain) {
      const text = htmlToText(inner);
      if (text) push({ id: id(), type: "paragraph", text });
      continue;
    }
    if (tag === "blockquote" && plain) {
      const text = htmlToText(inner);
      if (text) push({ id: id(), type: "quote", text });
      continue;
    }
    if ((tag === "ul" || tag === "ol") && !/<(ul|ol)\b/i.test(inner)) {
      const items: string[] = [];
      let structural = true;
      const li = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      for (let m = li.exec(inner); m; m = li.exec(inner)) {
        if (hasMarkup(m[1])) {
          structural = false;
          break;
        }
        const text = htmlToText(m[1]);
        if (text) items.push(text);
      }
      if (structural && items.length) {
        push({ id: id(), type: "list", ordered: tag === "ol", items });
        continue;
      }
    }
    if (tag === "pre") {
      const code = htmlToText(inner);
      if (code) {
        const lang = /class\s*=\s*["'][^"']*(?:language|lang)-([\w#+.-]+)/i.exec(inner);
        push({ id: id(), type: "code", ...(lang ? { language: lang[1] } : {}), code });
      }
      continue;
    }
    push({ id: id(), type: "html", html: chunk });
  }
  return blocks;
}

/** CDATA wins when present: WordPress ships titles and bodies inside it. */
function cdataOrText(raw: string): string {
  const cdata = [...raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
  return cdata.length ? cdata.join("") : decodeXmlEntities(raw);
}

function xmlTag(block: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}\\s*>`, "i").exec(block);
  return m ? cdataOrText(m[1]) : "";
}

function wxrStatus(raw: string): PostStatus | null {
  switch (raw.trim().toLowerCase()) {
    case "publish":
    case "future":
      return "published";
    case "trash":
    case "auto-draft":
      return null;
    case "draft":
    case "pending":
    case "private":
      return "draft";
    case "":
      return "published";
    default:
      return "draft";
  }
}

/** `2024-01-02 03:04:05` (GMT wins over local) → ISO string. */
function wxrStampToIso(gmtRaw: string, localRaw: string): string | undefined {
  const gmt = gmtRaw.trim();
  const local = localRaw.trim();
  const usable = (s: string) => !!s && !s.startsWith("0000-00-00");
  const pick = usable(gmt) ? gmt : usable(local) ? local : "";
  if (!pick) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(pick);
  const iso = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${pick === gmt ? "Z" : ""}` : pick;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function wxrDate(block: string): string | undefined {
  return wxrStampToIso(xmlTag(block, "wp:post_date_gmt"), xmlTag(block, "wp:post_date"));
}

type RawImportComment = Omit<ImportComment, "parentIndex"> & { sourceId?: number; parentId?: number };

// WordPress writes empty/"comment" for real comments; pingbacks and trackbacks
// have no block representation here, and trashed rows are noise.
const WXR_COMMENT_STATUS: Record<string, ImportComment["status"]> = {
  "": "published",
  "1": "published",
  approve: "published",
  approved: "published",
  "0": "pending",
  hold: "pending",
  unapproved: "pending",
  spam: "spam",
};

function wxrComments(block: string): RawImportComment[] {
  const out: RawImportComment[] = [];
  const re = /<wp:comment>([\s\S]*?)<\/wp:comment>/gi;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    if (out.length >= IMPORT_MAX_COMMENTS) break;
    const status = WXR_COMMENT_STATUS[xmlTag(m[1], "wp:comment_approved").trim().toLowerCase()];
    if (!status) continue;
    const type = xmlTag(m[1], "wp:comment_type").trim().toLowerCase();
    if (type && type !== "comment") continue;
    const content = xmlTag(m[1], "wp:comment_content").trim();
    if (!content) continue;
    const sourceId = Number(xmlTag(m[1], "wp:comment_id"));
    const parentId = Number(xmlTag(m[1], "wp:comment_parent"));
    const createdAt = wxrStampToIso(
      xmlTag(m[1], "wp:comment_date_gmt"),
      xmlTag(m[1], "wp:comment_date"),
    );
    out.push({
      ...(Number.isFinite(sourceId) && sourceId > 0 ? { sourceId } : {}),
      ...(Number.isFinite(parentId) && parentId > 0 ? { parentId } : {}),
      authorName: xmlTag(m[1], "wp:comment_author").trim(),
      authorEmail: xmlTag(m[1], "wp:comment_author_email").trim(),
      authorUrl: xmlTag(m[1], "wp:comment_author_url").trim(),
      content,
      status,
      ...(createdAt ? { createdAt } : {}),
    });
  }
  return out;
}

/** WordPress percent-encodes non-ASCII slugs in wp:post_name. */
function wxrSlug(raw: string, title: string): string {
  let s = raw.trim();
  if (s) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* malformed escapes are kept verbatim */
    }
  }
  return s || title;
}

function wxrTerms(block: string): { categories: string[]; tags: string[] } {
  const categories: string[] = [];
  const tags: string[] = [];
  const re = /<category\b([^>]*)>([\s\S]*?)<\/category>/gi;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    const domain = attrOf(m[1], "domain").toLowerCase();
    const name = cdataOrText(m[2]).trim();
    if (!name) continue;
    if (domain === "category") categories.push(name);
    else if (domain === "post_tag") tags.push(name);
  }
  return { categories, tags };
}

function wxrPostMeta(block: string): Map<string, string> {
  const meta = new Map<string, string>();
  const re = /<wp:postmeta\b[^>]*>([\s\S]*?)<\/wp:postmeta>/gi;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    const key = xmlTag(m[1], "wp:meta_key").trim();
    if (key && !meta.has(key)) meta.set(key, xmlTag(m[1], "wp:meta_value").trim());
  }
  return meta;
}

/** Attachments are dropped as items, but their URL is the cover posts point at. */
function wxrAttachmentUrls(text: string): Map<string, string> {
  const urls = new Map<string, string>();
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (let m = itemRe.exec(text); m; m = itemRe.exec(text)) {
    if (xmlTag(m[1], "wp:post_type").trim().toLowerCase() !== "attachment") continue;
    const id = xmlTag(m[1], "wp:post_id").trim();
    const url = xmlTag(m[1], "wp:attachment_url").trim();
    if (id && url) urls.set(id, url);
  }
  return urls;
}

/**
 * `wp:post_parent` is a numeric WordPress id, meaningless in another install,
 * so hierarchy is carried by slug instead: page id -> page slug, resolved in a
 * pre-pass because a child item can appear before its parent in the file.
 */
const WXR_SEO_KEYS = {
  seoTitle: ["_yoast_wpseo_title", "rank_math_title", "_aioseop_title"],
  seoDescription: ["_yoast_wpseo_metadesc", "rank_math_description", "_aioseop_description"],
  seoKeywords: ["_yoast_wpseo_focuskw", "rank_math_focus_keyword", "_aioseop_keywords"],
} as const;

// Yoast/Rank Math default to templates like %%title%% %%sep%% %%sitename%%;
// the placeholders are WordPress-only, so a value carrying one is not a title.
const SEO_TEMPLATE_RE = /%%[a-z0-9_]+%%|%[a-z0-9_]+%/i;

/** SEO fields live in plugin postmeta; the first real (non-template) value wins. */
function wxrSeoFields(meta: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, keys] of Object.entries(WXR_SEO_KEYS)) {
    for (const key of keys) {
      const value = (meta.get(key) ?? "").trim();
      if (value && !SEO_TEMPLATE_RE.test(value)) {
        out[field] = value;
        break;
      }
    }
  }
  return out;
}

const WXR_POST_FORMATS = new Set([
  "standard", "aside", "quote", "link", "image", "gallery", "video", "audio", "status",
]);

/** WordPress stores the post format as a post_format taxonomy row. */
function wxrFormat(block: string): string {
  const re = /<category\b([^>]*)>([\s\S]*?)<\/category>/gi;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    if (attrOf(m[1], "domain").toLowerCase() !== "post_format") continue;
    const name = attrOf(m[1], "nicename").toLowerCase().replace(/^post-format-/, "").trim();
    if (WXR_POST_FORMATS.has(name)) return name;
  }
  return "";
}

const WXR_META_EXCLUDE = /^(?:rank_math_|aioseo_|aios_)/i;

/**
 * postmeta holds three kinds of keys: WordPress internals (underscore prefix),
 * SEO plugin fields (already read into dedicated columns), and genuine custom
 * fields. Only the third kind belongs in post_metas — the others would come
 * back as junk keys on the next round trip.
 */
function wxrCustomMeta(meta: Map<string, string>): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of meta) {
    if (!key || key.startsWith("_") || key === "oboext_status" || WXR_META_EXCLUDE.test(key)) continue;
    const k = key.trim().slice(0, 100);
    if (k) out.push({ key: k, value });
  }
  return out;
}

/** Oboext's archived status travels in a marker; WordPress only sees private. */
function wxrStatusWithMarker(block: string, meta: Map<string, string>): PostStatus | null {
  const status = wxrStatus(xmlTag(block, "wp:status"));
  if (status && (meta.get("oboext_status") ?? "").trim().toLowerCase() === "archived") return "archived";
  return status;
}

function wxrPageSlugs(text: string): Map<string, string> {
  const slugs = new Map<string, string>();
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (let m = itemRe.exec(text); m; m = itemRe.exec(text)) {
    if (xmlTag(m[1], "wp:post_type").trim().toLowerCase() !== "page") continue;
    const id = xmlTag(m[1], "wp:post_id").trim();
    const title = xmlTag(m[1], "title").trim();
    if (!id || !title) continue;
    slugs.set(id, wxrSlug(xmlTag(m[1], "wp:post_name"), title));
  }
  return slugs;
}

/**
 * `wp:author` blocks keyed by both login and display name (lowercased).
 * WordPress puts the *login* in dc:creator and the readable name in the author
 * block; an Oboext export writes the same string in both. Indexing both keys
 * means either dialect resolves to one display name plus its email.
 */
function wxrAuthorIndex(text: string): Map<string, { name: string; email: string }> {
  const out = new Map<string, { name: string; email: string }>();
  const re = /<wp:author(?:\s[^>]*)?>([\s\S]*?)<\/wp:author\s*>/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const login = xmlTag(m[1], "wp:author_login").trim();
    const display = xmlTag(m[1], "wp:author_display_name").trim();
    const email = xmlTag(m[1], "wp:author_email").trim();
    if (!login && !display) continue;
    const entry = { name: display || login, email };
    for (const key of [login, display]) if (key) out.set(key.toLowerCase(), entry);
  }
  return out;
}

const WXR_SKIP_TYPES = new Set([
  "attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part",
  "wp_global_styles", "wp_navigation", "custom_css", "customize_changeset",
  "oembed_cache", "user_request", "wp_font_family", "wp_font_face",
]);

export function parseWxrImport(text: string): { posts: unknown[]; pages: unknown[] } {
  const posts: unknown[] = [];
  const pages: unknown[] = [];
  const attachmentUrls = wxrAttachmentUrls(text);
  const pageSlugs = wxrPageSlugs(text);
  const authorMeta = wxrAuthorIndex(text);
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (let m = itemRe.exec(text); m; m = itemRe.exec(text)) {
    const block = m[1];
    const type = xmlTag(block, "wp:post_type").trim().toLowerCase();
    if (WXR_SKIP_TYPES.has(type)) continue;
    if (type && type !== "post" && type !== "page") continue;
    const meta = wxrPostMeta(block);
    const status = wxrStatusWithMarker(block, meta);
    if (!status) continue;
    const title = xmlTag(block, "title").trim();
    // WordPress keeps auto-drafts and menu labels titleless; nothing to import.
    if (!title) continue;
    const excerpt = htmlToText(xmlTag(block, "excerpt:encoded")).slice(0, 2000);
    const publishedAt = wxrDate(block);
    const thumbId = meta.get("_thumbnail_id") ?? "";
    const featuredImage = (thumbId && attachmentUrls.get(thumbId)) || "";
    const commentStatus = xmlTag(block, "wp:comment_status").trim().toLowerCase();
    const slug = wxrSlug(xmlTag(block, "wp:post_name"), title);
    const wpParent = xmlTag(block, "wp:post_parent").trim();
    const parentSlug =
      (type === "page" && wpParent && wpParent !== "0" && pageSlugs.get(wpParent)) || "";
    const format = type === "post" ? wxrFormat(block) : "";
    const customMeta = wxrCustomMeta(meta);
    // R172 writes wp:is_sticky; read it back so pinned posts survive a move.
    // A missing tag stays undefined: an old export must not silently unpin.
    const sticky = type === "post" ? xmlTag(block, "wp:is_sticky").trim() : "";
    const pinned = sticky ? FRONT_TRUE.test(sticky) : undefined;
    // R176 writes pages' menu weight as wp:menu_order; read it back so a
    // WordPress page tree keeps its order. An absent tag means "0" anyway,
    // but a present 0 must reach normalizeItem as an explicit value.
    const menuOrder = type === "page" ? xmlTag(block, "wp:menu_order").trim() : "";
    const comments = wxrComments(block);
    // The byline: dc:creator carries the author key, the wp:author block turns
    // it into a display name plus the email. Reading it back is what keeps
    // authorship through a move — before R179 it was silently dropped.
    const creatorKey = xmlTag(block, "dc:creator").trim();
    const author = creatorKey ? authorMeta.get(creatorKey.toLowerCase()) : undefined;
    const creator = (author?.name || creatorKey).slice(0, 64);
    const creatorEmail = author?.email.trim().slice(0, 100) ?? "";
    const item: Record<string, unknown> = {
      title,
      slug,
      status,
      content: htmlBodyToBlocks(xmlTag(block, "content:encoded")),
      ...(excerpt ? { excerpt } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(featuredImage ? { featuredImage } : {}),
      ...(commentStatus === "open" || commentStatus === "closed" ? { commentStatus } : {}),
      ...(parentSlug && parentSlug !== slug ? { parentSlug } : {}),
      ...(menuOrder ? { order: menuOrder } : {}),
      ...(format ? { format } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(customMeta.length ? { metas: customMeta } : {}),
      ...(comments.length ? { comments } : {}),
      ...(creator ? { creator } : {}),
      ...(creatorEmail ? { creatorEmail } : {}),
      ...wxrTerms(block),
      ...wxrSeoFields(meta),
    };
    (type === "page" ? pages : posts).push(item);
  }
  return { posts, pages };
}

function looksLikeWxr(text: string): boolean {
  const head = text.slice(0, 20_000);
  return /<rss\b/i.test(head) && (/<wp:wxr_version\s*>/i.test(head) || /<wp:post_type\s*>/i.test(head));
}

// Markdown import has three shapes:
//   1. current exports — every entry is wrapped in
//      <!-- oboext:post|page:start --> … :end, so a body heading can never be
//      mistaken for the next entry;
//   2. older exports — "# 文章" / "# 独立页面" sections; taxonomy and comment
//      sections are skipped instead of turning into posts;
//   3. plain files — "## title" sections become posts, or the whole file is one
//      item titled from its first "# title".
type MarkdownSection = { title: string; meta: Record<string, string>; body: string[]; metaDone: boolean };

const MARKDOWN_ENTRY_RE = /<!--\s*oboext:(post|page):start\s*-->([\s\S]*?)<!--\s*oboext:\1:end\s*-->/g;
const MARKDOWN_SECTION_H1: Record<string, "posts" | "pages" | "skip"> = {
  文章: "posts",
  独立页面: "pages",
  分类与标签: "skip",
  评论: "skip",
};

function sectionFromChunk(chunk: string): MarkdownSection | null {
  const lines = chunk.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((line) => /^##\s+\S/.test(line));
  if (at < 0) return null;
  const title = lines[at].replace(/^##\s+/, "").trim();
  const section: MarkdownSection = { title, meta: {}, body: [], metaDone: false };
  for (const line of lines.slice(at + 1)) {
    const meta = line.match(META_RE);
    if (meta && !section.metaDone) {
      section.meta[meta[1]] = meta[2].trim();
      continue;
    }
    if (line.trim() !== "" || section.body.length) section.metaDone = true;
    section.body.push(line);
  }
  return section;
}

function sectionToItem(section: MarkdownSection): Record<string, unknown> {
  const item: Record<string, unknown> = {
    title: section.title,
    content: markdownBodyToBlocks(section.body.join("\n")),
  };
  applyMarkdownMeta(item, section.meta);
  return item;
}

export function parseMarkdownImportSections(text: string): { posts: unknown[]; pages: unknown[] } {
  if (/<!--\s*oboext:(?:post|page):start\s*-->/.test(text)) {
    const posts: unknown[] = [];
    const pages: unknown[] = [];
    for (const match of text.matchAll(MARKDOWN_ENTRY_RE)) {
      const section = sectionFromChunk(match[2]);
      if (section) (match[1] === "page" ? pages : posts).push(sectionToItem(section));
    }
    return { posts, pages };
  }

  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const front = parseFrontMatter(lines);
  if (front) {
    const body = lines.slice(front.end);
    const fmTitle = frontGet(front, "title");
    const at = body.findIndex((line) => line.trim() !== "");
    if (at >= 0) {
      const h1 = body[at].match(/^#\s+(.*)$/);
      // A leading H1 is the title when the header has none, and a duplicate
      // when it repeats the header title; otherwise it is real content.
      if (h1 && (!fmTitle || h1[1].trim() === fmTitle)) {
        if (!fmTitle) front.meta.title = h1[1].trim();
        body.splice(at, 1);
      }
    }
    const item: Record<string, unknown> = {
      content: markdownBodyToBlocks(body.join("\n")),
    };
    const kind = applyFrontMatter(item, front);
    if (!String(item.title ?? "").trim()) item.title = "未命名导入";
    return kind === "page" ? { posts: [], pages: [item] } : { posts: [item], pages: [] };
  }
  const exportDialect = lines.slice(0, 3).some((line) => /^#\s+Oboext 内容导出\s*$/.test(line));
  const posts: MarkdownSection[] = [];
  const pages: MarkdownSection[] = [];
  const preamble: string[] = [];
  let kind: "posts" | "pages" | "skip" = "posts";
  let current: MarkdownSection | null = null;
  const flush = () => {
    if (current && kind !== "skip") (kind === "pages" ? pages : posts).push(current);
    current = null;
  };
  for (const line of lines) {
    if (exportDialect) {
      const h1 = line.match(/^#\s+(.*)$/);
      const next = h1 ? MARKDOWN_SECTION_H1[h1[1].trim()] : undefined;
      if (next) {
        flush();
        kind = next;
        continue;
      }
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      flush();
      if (kind !== "skip") current = { title: h2[1].trim(), meta: {}, body: [], metaDone: false };
      continue;
    }
    if (current) {
      const meta = line.match(META_RE);
      if (meta && !current.metaDone) {
        current.meta[meta[1]] = meta[2].trim();
        continue;
      }
      if (line.trim() !== "" || current.body.length) current.metaDone = true;
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  flush();
  if (!posts.length && !pages.length && !exportDialect) {
    let title = "未命名导入";
    const body: string[] = [];
    let titled = false;
    for (const line of preamble) {
      const h1 = line.match(/^#\s+(.*)$/);
      if (!titled && h1) {
        title = h1[1].trim() || title;
        titled = true;
        continue;
      }
      body.push(line);
    }
    const meta: Record<string, string> = {};
    const rest: string[] = [];
    let metaDone = false;
    for (const line of body) {
      const m = line.match(META_RE);
      if (m && !metaDone) {
        meta[m[1]] = m[2].trim();
        continue;
      }
      if (line.trim() !== "" || rest.length) metaDone = true;
      rest.push(line);
    }
    const item: Record<string, unknown> = { title, content: markdownBodyToBlocks(rest.join("\n")) };
    applyMarkdownMeta(item, meta);
    return { posts: [item], pages: [] };
  }
  return { posts: posts.map(sectionToItem), pages: pages.map(sectionToItem) };
}

export function parseMarkdownImport(text: string): unknown[] {
  return parseMarkdownImportSections(text).posts;
}

const BUNDLE_MARKDOWN_RE = /\.(?:md|markdown|mdown|mkd|txt)$/i;
// Site repos ship these next to content; importing them as posts pollutes the
// blog, so only root-level copies are dropped (a post named README.md in a
// sub-folder is still treated as content).
const BUNDLE_ROOT_DOC_RE = /^(?:readme|changelog|license|licence|contributing|code_of_conduct|security)(?:\.[a-z]+)?$/i;

/** ZIP entries worth inflating: Markdown in real content folders, no caches. */
export function isMarkdownBundleEntry(name: string): boolean {
  const segs = name.replace(/\\/g, "/").split("/");
  const junk = segs.some(
    (s) => s === "__MACOSX" || s === "node_modules" || (s.startsWith(".") && s !== "." && s !== ".."),
  );
  return !junk && BUNDLE_MARKDOWN_RE.test(name);
}

export type BundleSkip = { name: string; reason: string };

function bundleFileMeta(name: string): { title: string; date?: string } {
  const base = (name.split("/").pop() ?? name).replace(BUNDLE_MARKDOWN_RE, "");
  // Jekyll/Hexo name files YYYY-MM-DD-slug.md; keep that date as publishedAt.
  const dated = base.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[-_]+(.+)$/);
  const stem = dated ? dated[4] : base;
  return {
    title: stem.replace(/[-_]+/g, " ").trim() || "未命名导入",
    ...(dated ? { date: `${dated[1]}-${dated[2]}-${dated[3]}` } : {}),
  };
}

function applyBundleFileMeta(raw: unknown, file: { title: string; date?: string }) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const item = raw as Record<string, unknown>;
  const title = str(item.title).trim();
  if (!title || title === "未命名导入") item.title = file.title;
  if (!str(item.publishedAt).trim() && file.date) item.publishedAt = file.date;
}

/**
 * A ZIP bundle is a folder of Markdown exports — one file per post usually,
 * but a per-file Oboext export may hold several sections; both merge here.
 */
export function parseMarkdownBundle(entries: { name: string; data: Buffer }[]): {
  posts: unknown[];
  pages: unknown[];
  files: number;
  skipped: BundleSkip[];
} {
  const posts: unknown[] = [];
  const pages: unknown[] = [];
  const skipped: BundleSkip[] = [];
  let files = 0;
  // GitHub "Download ZIP" archives nest everything under one repo folder; the
  // repo's README sits at that virtual root and must not become a post.
  const tops = new Set(entries.map((e) => e.name.split("/")[0]));
  const wrapper =
    tops.size === 1 && entries.every((e) => e.name.includes("/")) ? [...tops][0] : undefined;
  for (const entry of entries) {
    const base = entry.name.split("/").pop() ?? entry.name;
    const rel = wrapper && entry.name.startsWith(wrapper + "/") ? entry.name.slice(wrapper.length + 1) : entry.name;
    if (!rel.includes("/") && BUNDLE_ROOT_DOC_RE.test(base)) {
      skipped.push({ name: entry.name, reason: "根目录说明文档，未导入" });
      continue;
    }
    if (entry.data.length > IMPORT_ZIP_MAX_ENTRY_BYTES) {
      skipped.push({ name: entry.name, reason: "文件过大（单文件上限 2MB）" });
      continue;
    }
    const text = entry.data.toString("utf8");
    if (!text.trim()) {
      skipped.push({ name: entry.name, reason: "空文件" });
      continue;
    }
    files++;
    const parsed = parseMarkdownImportSections(text);
    const meta = bundleFileMeta(entry.name);
    for (const item of [...parsed.posts, ...parsed.pages]) applyBundleFileMeta(item, meta);
    posts.push(...parsed.posts);
    pages.push(...parsed.pages);
  }
  if (!posts.length && !pages.length)
    throw new ServiceError("压缩包里没有可导入的 Markdown 内容", 422);
  return { posts, pages, files, skipped };
}

function looksLikeMarkdown(text: string): boolean {
  const head = text.slice(0, 4000);
  return /(^|\n)#{1,4}\s/.test(head) || /(^|\n)[-*]\s/.test(head) || /\S/.test(head);
}

export type ParsedImport = { format: "json" | "markdown" | "wxr"; posts: unknown[]; pages: unknown[] };
export function parseImportText(text: string): ParsedImport {
  const trimmed = text.trim();
  if (looksLikeWxr(trimmed)) {
    const wxr = parseWxrImport(trimmed);
    return { format: "wxr", ...wxr };
  }
  // A subscription feed shares the <rss>/<feed> root with WXR but carries no
  // wp:* payload; name the file for what it is instead of importing XML as a
  // Markdown body.
  if (/<rss[\s>]/i.test(trimmed) || /<feed[\s>][^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(trimmed))
    throw new ServiceError("这是 RSS/Atom 订阅源，不是 WordPress 导出文件（WXR）", 422);
  if (trimmed.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new ServiceError("文件不是合法的 JSON", 422);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data))
      throw new ServiceError("JSON 顶层必须是对象", 422);
    const obj = data as Record<string, unknown>;
    if (obj.tool !== "oboext") throw new ServiceError("不是 Oboext 导出文件（缺少 tool 标识）", 422);
    if (obj.version !== 1) throw new ServiceError(`不支持的导出版本：${String(obj.version)}`, 422);
    const posts = obj.posts;
    const pages = obj.pages;
    if (posts !== undefined && !Array.isArray(posts))
      throw new ServiceError("posts 字段必须是数组", 422);
    if (pages !== undefined && !Array.isArray(pages))
      throw new ServiceError("pages 字段必须是数组", 422);
    if (!Array.isArray(posts) && !Array.isArray(pages))
      throw new ServiceError("文件里没有可导入的文章或页面", 422);
    return { format: "json", posts: (posts as unknown[]) ?? [], pages: (pages as unknown[]) ?? [] };
  }
  if (!looksLikeMarkdown(text)) throw new ServiceError("无法识别文件格式", 422);
  return { format: "markdown", ...parseMarkdownImportSections(text) };
}

function checkBlocks(v: unknown): Block[] | string {
  if (!Array.isArray(v)) return "content 必须是数组";
  if (v.length > IMPORT_MAX_BLOCKS) return "内容块数量过多";
  for (const b of v) {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return "内容块格式不正确";
  }
  return v as Block[];
}

export type NormalizedResult = { ok: true; item: NormalizedItem } | { ok: false; reason: string };

// Meta values are text in the DB, but a hand-made JSON file may carry numbers
// or booleans; String() keeps them instead of silently storing "". Admin's
// normFormatMeta coerces the same way, so dry-run and apply agree.
function metaValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// JSON export writes an object map; the admin form and some hand-made files use
// [{key,value}]. Fold both into the array the write path expects, mirroring
// cleanMetas (trim + 100-char key cap + last-wins dedupe) so dry-run and apply
// agree on what will be stored.
function metaList(v: unknown): { key: string; value: string }[] | string {
  const byKey = new Map<string, string>();
  if (Array.isArray(v)) {
    for (const m of v) {
      if (m === null || typeof m !== "object") return "自定义字段格式不正确";
      const key = str((m as Record<string, unknown>).key).trim().slice(0, 100);
      if (key) byKey.set(key, metaValue((m as Record<string, unknown>).value));
    }
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const key = k.trim().slice(0, 100);
      if (key) byKey.set(key, metaValue(val));
    }
  } else {
    return "自定义字段格式不正确";
  }
  return [...byKey].map(([key, value]) => ({ key, value }));
}

function formatMetaMap(v: unknown): Record<string, string> | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "文章形式字段格式不正确";
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim();
    if (key) out[key.slice(0, 100)] = metaValue(val);
  }
  return out;
}

/**
 * Comments are secondary data: one malformed row is skipped instead of failing
 * the whole post, and the cap keeps a hostile file from ballooning the insert.
 * Parent links are resolved to list positions so they remap after insertion.
 */
function normalizeComments(raw: unknown): ImportComment[] {
  if (!Array.isArray(raw)) return [];
  const kept: { comment: Omit<ImportComment, "parentIndex">; parentSource: number }[] = [];
  const indexBySource = new Map<number, number>();
  for (const value of raw as Record<string, unknown>[]) {
    if (kept.length >= IMPORT_MAX_COMMENTS) break;
    const content = str(value?.content).trim().slice(0, IMPORT_MAX_COMMENT_CHARS);
    if (!content) continue;
    const status = str(value?.status).trim().toLowerCase();
    if (status !== "published" && status !== "pending" && status !== "spam") continue;
    const created = str(value?.createdAt);
    const createdAt = created && Number.isFinite(Date.parse(created)) ? new Date(created).toISOString() : undefined;
    const authorEmail = str(value?.authorEmail).trim().slice(0, 200);
    const authorUrl = str(value?.authorUrl).trim().slice(0, 500);
    const sourceId = Number(value?.sourceId);
    if (Number.isFinite(sourceId) && sourceId > 0) indexBySource.set(sourceId, kept.length);
    kept.push({
      comment: {
        authorName: str(value?.authorName).trim().slice(0, 100) || "匿名访客",
        content,
        status,
        ...(authorEmail ? { authorEmail } : {}),
        ...(authorUrl ? { authorUrl } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      parentSource: Number(value?.parentId) || 0,
    });
  }
  return kept.map(({ comment, parentSource }, index) => {
    const parentIndex = indexBySource.get(parentSource);
    return parentIndex != null && parentIndex !== index ? { ...comment, parentIndex } : comment;
  });
}

export function normalizeItem(raw: unknown): NormalizedResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "条目必须是对象" };
  const o = raw as Record<string, unknown>;
  const title = str(o.title).trim();
  if (!title) return { ok: false, reason: "标题不能为空" };
  if (title.length > 200) return { ok: false, reason: "标题长度不能超过 200 个字符" };
  let slug = str(o.slug).trim();
  if (slug.length > 100) return { ok: false, reason: "别名长度不能超过 100 个字符" };
  slug = slug ? slugify(slug) : slugify(title);
  if (!slug) return { ok: false, reason: "别名无法生成" };
  if (o.status != null && o.status !== "" && !normalizeStatus(o.status))
    return { ok: false, reason: `状态无法识别：${str(o.status).slice(0, 30)}` };
  const status = normalizeStatus(o.status) ?? "draft";
  const excerpt = str(o.excerpt);
  if (excerpt.length > 2000) return { ok: false, reason: "摘要长度不能超过 2000 个字符" };
  const content = checkBlocks(o.content ?? []);
  if (typeof content === "string") return { ok: false, reason: content };
  let publishedAt: string | undefined;
  if (o.publishedAt != null && o.publishedAt !== "") {
    if (Number.isNaN(Date.parse(String(o.publishedAt))))
      return { ok: false, reason: "发布时间格式不正确" };
    publishedAt = new Date(String(o.publishedAt)).toISOString();
  }
  // Presentation fields a migration must keep: cover and SEO metadata. Caps
  // mirror admin.ts so a hostile file cannot stuff multi-megabyte values into
  // the import path (the JSON body cap is 10 MB, far above these limits).
  const featuredImage = str(o.featuredImage);
  if (featuredImage.length > 500) return { ok: false, reason: "封面地址长度不能超过 500 个字符" };
  const seoTitle = str(o.seoTitle);
  if (seoTitle.length > 200) return { ok: false, reason: "SEO 标题长度不能超过 200 个字符" };
  const seoDescription = str(o.seoDescription);
  if (seoDescription.length > 500) return { ok: false, reason: "SEO 描述长度不能超过 500 个字符" };
  const seoKeywords = str(o.seoKeywords);
  if (seoKeywords.length > 500) return { ok: false, reason: "SEO 关键词长度不能超过 500 个字符" };
  let metas: { key: string; value: string }[] | undefined;
  if (o.metas !== undefined || o.metaList !== undefined) {
    const parsed = metaList(o.metas !== undefined ? o.metas : o.metaList);
    if (typeof parsed === "string") return { ok: false, reason: parsed };
    metas = parsed;
  }
  let formatMeta: Record<string, string> | undefined;
  if (o.formatMeta !== undefined) {
    const parsed = formatMetaMap(o.formatMeta);
    if (typeof parsed === "string") return { ok: false, reason: parsed };
    formatMeta = parsed;
  }
  const commentStatus = str(o.commentStatus).trim();
  if (commentStatus && commentStatus !== "open" && commentStatus !== "closed")
    return { ok: false, reason: "评论状态必须是 open 或 closed" };
  const pinned =
    typeof o.pinned === "boolean" ? o.pinned : FRONT_TRUE.test(str(o.pinned).trim()) ? true : undefined;
  const format = str(o.format).trim();
  if (format.length > 50) return { ok: false, reason: "文章形式长度不能超过 50 个字符" };
  const template = str(o.template).trim();
  if (template.length > 100) return { ok: false, reason: "模板名称长度不能超过 100 个字符" };
  // Pages carry a menu weight (WordPress menu_order / Hugo weight); dropping
  // it on import would silently reorder a migrated page tree.
  let order: number | undefined;
  if (o.order !== undefined && o.order !== null && String(o.order).trim() !== "") {
    const n = Number(o.order);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000)
      return { ok: false, reason: "排序值必须是 0 到 1000000 的整数" };
    order = n;
  }
  // Hierarchy travels as a slug, not as the source database's numeric id.
  // A self-reference is dropped instead of failing the item: it cannot render
  // as a tree edge and the page itself is still worth importing.
  let parentSlug: string | undefined;
  const rawParent = str(o.parentSlug).trim();
  if (rawParent.length > 100) return { ok: false, reason: "父页面别名长度不能超过 100 个字符" };
  if (rawParent) {
    parentSlug = slugify(rawParent);
    if (!parentSlug) return { ok: false, reason: "父页面别名无法生成" };
    if (parentSlug === slug) parentSlug = undefined;
  }
  if (o.metaError) return { ok: false, reason: str(o.metaError) };
  // Authorship travels as a name, never as the source database's numeric id.
  // An over-long byline is truncated rather than rejected: users.name caps at
  // 64 and losing the tag would lose the post's author outright.
  const authorRow = (o.author ?? null) as { name?: unknown } | null;
  const creator = (str(o.creator).trim() || str(authorRow?.name).trim()).slice(0, 64);
  const creatorEmail = str(o.creatorEmail).trim().slice(0, 100);
  const comments = normalizeComments(o.comments);
  return {
    ok: true,
    item: {
      title,
      slug,
      status,
      excerpt,
      content,
      categories: termNames(o.categories),
      tags: termNames(o.tags),
      ...(publishedAt ? { publishedAt } : {}),
      ...(featuredImage ? { featuredImage } : {}),
      ...(seoTitle ? { seoTitle } : {}),
      ...(seoDescription ? { seoDescription } : {}),
      ...(seoKeywords ? { seoKeywords } : {}),
      ...(metas ? { metas } : {}),
      ...(commentStatus ? { commentStatus: commentStatus as "open" | "closed" } : {}),
      ...(format ? { format } : {}),
      ...(formatMeta ? { formatMeta } : {}),
      ...(template ? { template } : {}),
      ...(order !== undefined ? { order } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(parentSlug ? { parentSlug } : {}),
      ...(comments.length ? { comments } : {}),
      ...(creator ? { creator } : {}),
      ...(creatorEmail ? { creatorEmail } : {}),
    },
  };
}

export function planKind(kind: ImportKind, raws: unknown[], existing: Map<string, number>): KindPlan {
  const plan: KindPlan = { total: raws.length, valid: [], issues: [], conflicts: [], creates: 0, comments: 0 };
  raws.forEach((raw, index) => {
    const res = normalizeItem(raw);
    const issue = (reason: string) =>
      plan.issues.push({
        index,
        title: str((raw as Record<string, unknown> | null)?.title).slice(0, 60),
        reason,
      });
    if (!res.ok) {
      issue(res.reason);
      return;
    }
    // pages.ts is stricter than admin.ts for two fields; catch it here so
    // dry-run never promises an item the write path would reject.
    if (kind === "page") {
      if (res.item.excerpt.length > 500) return issue("页面摘要长度不能超过 500 个字符");
      if ((res.item.seoDescription ?? "").length > 300)
        return issue("页面 SEO 描述长度不能超过 300 个字符");
    }
    const hit = existing.get(res.item.slug);
    if (hit != null) plan.conflicts.push({ slug: res.item.slug, title: res.item.title, existingId: hit });
    plan.valid.push(res.item);
    plan.comments += res.item.comments?.length ?? 0;
  });
  plan.creates = plan.valid.length - plan.conflicts.length;
  return plan;
}

export async function loadExistingSlugs(kind: ImportKind): Promise<Map<string, number>> {
  const table = kind === "post" ? posts : pagesTable;
  const rows = await db.select({ id: table.id, slug: table.slug }).from(table);
  return new Map(rows.map((r) => [r.slug, r.id]));
}

async function planParsed(
  parsed: { format: ImportPlan["format"]; posts: unknown[]; pages: unknown[] },
  bundle?: ImportPlan["bundle"],
): Promise<ImportPlan> {
  if (parsed.posts.length + parsed.pages.length > IMPORT_MAX_ITEMS)
    throw new ServiceError(`条目过多（上限 ${IMPORT_MAX_ITEMS}）`, 422);
  const [postSlugs, pageSlugs] = await Promise.all([
    parsed.posts.length ? loadExistingSlugs("post") : Promise.resolve(new Map<string, number>()),
    parsed.pages.length ? loadExistingSlugs("page") : Promise.resolve(new Map<string, number>()),
  ]);
  return {
    format: parsed.format,
    posts: planKind("post", parsed.posts, postSlugs),
    pages: planKind("page", parsed.pages, pageSlugs),
    ...(bundle ? { bundle } : {}),
  };
}

export async function buildImportPlan(text: string): Promise<ImportPlan> {
  return planParsed(parseImportText(text));
}

export async function buildMarkdownBundlePlan(entries: { name: string; data: Buffer }[]): Promise<ImportPlan> {
  const parsed = parseMarkdownBundle(entries);
  return planParsed(
    { format: "zip", posts: parsed.posts, pages: parsed.pages },
    { files: parsed.files, skipped: parsed.skipped },
  );
}

function summarizeKind(p: KindPlan) {
  return {
    total: p.total,
    valid: p.valid.length,
    issues: p.issues.length,
    conflicts: p.conflicts.length,
    creates: p.creates,
    comments: p.comments,
  };
}

export function summarizePlan(plan: ImportPlan) {
  return {
    format: plan.format,
    comments: plan.posts.comments + plan.pages.comments,
    posts: summarizeKind(plan.posts),
    pages: summarizeKind(plan.pages),
    ...(plan.bundle ? { bundle: plan.bundle } : {}),
  };
}

export type ApplyResult = {
  posts: { created: number; updated: number; skipped: number; authors: AuthorStats };
  pages: { created: number; updated: number; skipped: number; authors: AuthorStats };
  comments: number;
  /** Bylines the file carried: attributed items, new accounts, items past the cap. */
  authors: AuthorStats;
  terms: { categories: number; tags: number };
  errors: string[];
};

type TermIndex = {
  categories: Map<string, number>;
  tags: Map<string, number>;
  created: { categories: number; tags: number };
};

async function loadTermIndex(): Promise<TermIndex> {
  const [cats, tgs] = await Promise.all([listCategories(), listTags()]);
  const byName = (rows: { id: number; name: string }[]) =>
    new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));
  return { categories: byName(cats), tags: byName(tgs), created: { categories: 0, tags: 0 } };
}

/** Match by display name (case-insensitive), creating the term when absent. */
async function resolveTerms(
  user: SessionUser,
  kind: "category" | "tag",
  names: string[],
  index: TermIndex,
): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const pool = kind === "category" ? index.categories : index.tags;
    let id = pool.get(name.toLowerCase());
    if (id == null) {
      const row = kind === "category" ? await createCategory(user, { name }) : await createTag(user, { name });
      id = row.id;
      pool.set(name.toLowerCase(), id);
      index.created[kind === "category" ? "categories" : "tags"] += 1;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Appends a WXR comment thread to an item that was just created. Rows go in as
 * one insert (order is preserved, which pairs each row with its new id), then
 * the second pass rewrites parent_id and recomputes the derived comment count.
 * A failure here is reported but never undoes the item itself.
 */
async function appendComments(
  list: ImportComment[],
  postId: number,
  postType: ImportKind,
  title: string,
  errors: string[],
): Promise<number> {
  if (!list.length) return 0;
  try {
    const rows = list.map((c) => ({
      postId,
      postType,
      userId: null,
      authorName: c.authorName,
      authorEmail: c.authorEmail ?? null,
      authorUrl: c.authorUrl ?? null,
      content: c.content,
      status: c.status,
      ip: null,
      ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
    }));
    const inserted = await db
      .insert(commentsTable)
      .values(rows)
      .returning({ id: commentsTable.id });
    for (const [index, comment] of list.entries()) {
      const parentId = comment.parentIndex != null ? inserted[comment.parentIndex]?.id : undefined;
      const id = inserted[index]?.id;
      if (parentId == null || id == null) continue;
      await rawQuery(`UPDATE comments SET parent_id = $1 WHERE id = $2`, [parentId, id]);
    }
    // Derived count, recomputed instead of incremented: self-healing and one
    // statement regardless of how many comments the file carried.
    await rawQuery(
      `UPDATE ${postType === "page" ? "pages" : "posts"} SET comments_count =
         (SELECT count(*) FROM comments c
           WHERE c.post_id = $1 AND c.post_type = $2 AND c.status = 'published')
       WHERE id = $1`,
      [postId, postType],
    );
    return rows.length;
  } catch (e) {
    const msg = e instanceof ServiceError ? e.message : String(e);
    errors.push(`${title} 的评论：${msg}`);
    log.warn("import comments failed", { postId, postType, err: msg });
    return 0;
  }
}

type AuthorStats = { matched: number; created: number; capped: number };

const IMPORT_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve-or-create pool for the bylines a file carries.
 *
 * Names match case-insensitively against the live accounts, so the common case
 * — an Oboext export imported back into the same or a new site — reattaches
 * posts to the real author instead of inventing a duplicate. A name nobody owns
 * gets a placeholder `author` account; an over-cap file attributes the rest to
 * the importer rather than failing the items.
 */
async function createAuthorPool(
  errors: string[],
): Promise<{ idOf: (creator: string, email: string) => Promise<number | undefined>; stats: AuthorStats }> {
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable);
  const byName = new Map<string, number>();
  const takenEmails = new Set<string>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, r.id);
    const email = (r.email ?? "").trim().toLowerCase();
    if (email) takenEmails.add(email);
  }
  const stats: AuthorStats = { matched: 0, created: 0, capped: 0 };
  const idOf = async (creator: string, email: string): Promise<number | undefined> => {
    const name = creator.trim();
    const key = name.toLowerCase();
    if (!key) return undefined;
    const hit = byName.get(key);
    if (hit) {
      stats.matched++;
      return hit;
    }
    if (stats.created >= IMPORT_MAX_AUTHORS) {
      stats.capped++;
      return undefined;
    }
    // A unique index treats '' as a value, so a second ownerless byline would
    // collide; NULL keeps such accounts addressless but insertable.
    const safeEmail = IMPORT_EMAIL_SHAPE.test(email) && !takenEmails.has(email.toLowerCase()) ? email : "";
    try {
      const [row] = await db
        .insert(usersTable)
        .values({
          name,
          email: safeEmail || null,
          // verifyCredentials hashes whatever the login form sends, so the
          // digest must stay format-valid or a name-based login attempt would
          // throw instead of failing. The preimage is random and discarded.
          passwordHash: await hashPassword(crypto.randomBytes(24).toString("base64")),
          role: "author",
          passwordless: true,
        })
        .returning({ id: usersTable.id });
      byName.set(key, row.id);
      if (safeEmail) takenEmails.add(safeEmail.toLowerCase());
      stats.created++;
      stats.matched++;
      return row.id;
    } catch (e) {
      const msg = e instanceof ServiceError ? e.message : String(e);
      errors.push(`作者「${name.slice(0, 32)}」账号创建失败：${msg}`);
      log.warn("import author create failed", { name, err: msg });
      return undefined;
    }
  };
  return { idOf, stats };
}

async function applyKind(
  user: SessionUser,
  kind: ImportKind,
  plan: KindPlan,
  policy: ImportPolicy,
  errors: string[],
  index: TermIndex,
): Promise<{
  created: number;
  updated: number;
  skipped: number;
  comments: number;
  authors: AuthorStats;
}> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let commentsImported = 0;
  // Only an account that may reassign authors gets a byline pool: createPost
  // ignores authorId for everyone else, so an author-role importer would pay
  // for lookups that can never land. Pages have no author column at all.
  const wantsAuthors = kind === "post" && (user.role === "admin" || user.role === "editor");
  const pool = wantsAuthors && plan.valid.some((i) => i.creator) ? await createAuthorPool(errors) : null;
  // Hierarchy takes two passes: a child may name a parent that only appears
  // later in the file (or is absent entirely). The slug -> id map is seeded
  // with the live pages so a partial export still resolves existing parents.
  const linksParents = kind === "page" && plan.valid.some((i) => i.parentSlug);
  const pageIds = linksParents ? await loadExistingSlugs("page") : new Map<string, number>();
  const pendingParents: { id: number; parentSlug: string }[] = [];
  // R276: translation pairs resolve in the same two-pass shape — a file may
  // list the en twin before its zh original, so pairing waits for pass two.
  const linksTranslations = kind === "post" && plan.valid.some((i) => i.translationOfSlug);
  const postIds = linksTranslations ? await loadExistingSlugs("post") : new Map<string, number>();
  const pendingTranslations: { id: number; originalSlug: string }[] = [];
  for (const rawItem of plan.valid) {
    const { parentSlug, comments: itemComments, creator, creatorEmail, translationOfSlug, ...item } = rawItem;
    const hit = plan.conflicts.find((c) => c.slug === item.slug);
    try {
      if (hit && policy === "skip") {
        // A skipped page can still be the parent of a page that is created.
        if (linksParents) pageIds.set(item.slug, hit.existingId);
        skipped++;
        continue;
      }
      // Only attach taxonomies the file actually names: an overwrite of an
      // item that carried none must not wipe the post's existing terms.
      const categoryIds = kind === "post" && item.categories.length
        ? await resolveTerms(user, "category", item.categories, index)
        : [];
      const tagIds = kind === "post" && item.tags.length
        ? await resolveTerms(user, "tag", item.tags, index)
        : [];
      const knownParent = linksParents && parentSlug ? pageIds.get(parentSlug) : undefined;
      const authorId = pool && creator ? await pool.idOf(creator, creatorEmail ?? "") : undefined;
      const input = {
        ...item,
        ...(knownParent != null ? { parentId: knownParent } : {}),
        ...(authorId ? { authorId } : {}),
        ...(categoryIds.length ? { categoryIds } : {}),
        ...(tagIds.length ? { tagIds } : {}),
      };
      if (hit) {
        if (kind === "post") {
          await updatePost(user, hit.existingId, input);
          if (linksTranslations && translationOfSlug) {
            postIds.set(item.slug, hit.existingId);
            pendingTranslations.push({ id: hit.existingId, originalSlug: translationOfSlug });
          }
        } else {
          await updatePage(user, hit.existingId, input);
          pageIds.set(item.slug, hit.existingId);
          if (linksParents && parentSlug && knownParent == null)
            pendingParents.push({ id: hit.existingId, parentSlug });
        }
        updated++;
      } else if (kind === "post") {
        const row = await createPost(user, input);
        created++;
        if (linksTranslations && translationOfSlug) {
          postIds.set(item.slug, row.id);
          pendingTranslations.push({ id: row.id, originalSlug: translationOfSlug });
        }
        // Comments ride along only with a new item: re-importing over an
        // existing post must not double the thread.
        commentsImported += await appendComments(itemComments ?? [], row.id, kind, item.title, errors);
      } else {
        const row = await createPage(user, input);
        created++;
        commentsImported += await appendComments(itemComments ?? [], row.id, kind, item.title, errors);
        if (linksParents) {
          pageIds.set(item.slug, row.id);
          if (parentSlug && knownParent == null)
            pendingParents.push({ id: row.id, parentSlug });
        }
      }
    } catch (e) {
      const msg = e instanceof ServiceError ? e.message : String(e);
      errors.push(`${item.title}：${msg}`);
      log.warn("import item failed", { kind, slug: item.slug, err: msg });
    }
  }
  // Second pass: forward references resolve now that every page exists.
  for (const { id, parentSlug } of pendingParents) {
    const parentId = pageIds.get(parentSlug);
    if (!parentId || parentId === id) continue;
    try {
      await updatePage(user, id, { parentId });
    } catch (e) {
      const msg = e instanceof ServiceError ? e.message : String(e);
      errors.push(`父页面 ${parentSlug}：${msg}`);
      log.warn("import parent link failed", { id, parentSlug, err: msg });
    }
  }
  // R276 second pass: translation pairs. The original's slug may belong to a
  // row created earlier in THIS import (pageIds/postIds grew during pass one)
  // or to a row the site already had. A slug that resolved to the item itself
  // is self-pairing — rejected here rather than surfacing the 422.
  for (const { id, originalSlug } of pendingTranslations) {
    const originalId = postIds.get(originalSlug);
    if (!originalId || originalId === id) {
      errors.push(`翻译关联 ${originalSlug}：原文不存在于本文件或本站`);
      continue;
    }
    try {
      await updatePost(user, id, { translationOf: originalId });
    } catch (e) {
      const msg = e instanceof ServiceError ? e.message : String(e);
      errors.push(`翻译关联 ${originalSlug}：${msg}`);
      log.warn("import translation link failed", { id, originalSlug, err: msg });
    }
  }
  return {
    created,
    updated,
    skipped,
    comments: commentsImported,
    authors: pool ? pool.stats : { matched: 0, created: 0, capped: 0 },
  };
}

export async function applyImport(
  user: SessionUser,
  plan: ImportPlan,
  policy: ImportPolicy,
): Promise<ApplyResult> {
  const errors: string[] = [];
  const index = await loadTermIndex();
  const posts = await applyKind(user, "post", plan.posts, policy, errors, index);
  const pages = await applyKind(user, "page", plan.pages, policy, errors, index);
  await invalidateContentCaches();
  const authors = {
    matched: posts.authors.matched + pages.authors.matched,
    created: posts.authors.created + pages.authors.created,
    capped: posts.authors.capped + pages.authors.capped,
  };
  return { posts, pages, comments: posts.comments + pages.comments, authors, terms: index.created, errors };
}
