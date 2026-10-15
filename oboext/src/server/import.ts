// Content import — the counterpart of export.ts. Two dialects:
//   JSON      the oboext export envelope ({tool:"oboext", version:1, posts?, pages?})
//   Markdown  the dialect export.ts itself writes (## title + "- 别名：…" meta),
//             plus generic markdown (first "# title" or "未命名导入")
// Import goes through createPost/createPage/updatePost/updatePage, so shape
// validation, slug uniquifying, revision snapshots and cache invalidation all
// come from the normal write path — nothing here writes to the tables directly.
import { db } from "./db.js";
import { posts, pages as pagesTable } from "./schema.js";
import type { Block } from "./schema.js";
import type { SessionUser } from "./auth.js";
import { ServiceError } from "./errors.js";
import { createLogger } from "./logger.js";
import { createPost, slugify, updatePost } from "./admin.js";
import { createPage, updatePage } from "./pages.js";
import { invalidateContentCaches } from "./cache.js";

const log = createLogger("import");

export type ImportKind = "post" | "page";
export type ImportPolicy = "skip" | "overwrite";
export type PostStatus = "draft" | "published" | "archived";

export const IMPORT_MAX_ITEMS = 200;
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_BLOCKS = 2000;

export type NormalizedItem = {
  title: string;
  slug: string;
  status: PostStatus;
  excerpt: string;
  content: Block[];
  publishedAt?: string;
};

export type ItemIssue = { index: number; title: string; reason: string };

export type KindPlan = {
  total: number;
  valid: NormalizedItem[];
  issues: ItemIssue[];
  conflicts: { slug: string; title: string; existingId: number }[];
  creates: number;
};

export type ImportPlan = {
  format: "json" | "markdown";
  posts: KindPlan;
  pages: KindPlan;
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

const META_RE = /^[-*]\s*(别名|状态|摘要|分类|标签|创建时间|更新时间)\s*[：:]\s*(.*)$/;

// Split a markdown import into raw items. Sections start at "## title" (the
// export dialect); a file without any becomes one item titled from its first
// "# title", or 未命名导入.
export function parseMarkdownImport(text: string): unknown[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: { title: string; meta: Record<string, string>; body: string[]; metaDone: boolean }[] = [];
  let current: { title: string; meta: Record<string, string>; body: string[]; metaDone: boolean } | null = null;
  const preamble: string[] = [];
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      if (current) sections.push(current);
      current = { title: h2[1].trim(), meta: {}, body: [], metaDone: false };
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
  if (current) sections.push(current);
  if (!sections.length) {
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
    if (meta["别名"]) item.slug = meta["别名"];
    if (meta["状态"]) item.status = meta["状态"];
    if (meta["摘要"]) item.excerpt = meta["摘要"];
    return [item];
  }
  return sections.map((s) => {
    const item: Record<string, unknown> = {
      title: s.title,
      content: markdownBodyToBlocks(s.body.join("\n")),
    };
    if (s.meta["别名"]) item.slug = s.meta["别名"];
    if (s.meta["状态"]) item.status = s.meta["状态"];
    if (s.meta["摘要"]) item.excerpt = s.meta["摘要"];
    return item;
  });
}

function looksLikeMarkdown(text: string): boolean {
  const head = text.slice(0, 4000);
  return /(^|\n)#{1,4}\s/.test(head) || /(^|\n)[-*]\s/.test(head) || /\S/.test(head);
}

export type ParsedImport = { format: "json" | "markdown"; posts: unknown[]; pages: unknown[] };

export function parseImportText(text: string): ParsedImport {
  const trimmed = text.trim();
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
    if (obj.tool !== "oboext") throw new ServiceError("不是 oboext 导出文件（缺少 tool 标识）", 422);
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
  return { format: "markdown", posts: parseMarkdownImport(text), pages: [] };
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
  return { ok: true, item: { title, slug, status, excerpt, content, ...(publishedAt ? { publishedAt } : {}) } };
}

export function planKind(kind: ImportKind, raws: unknown[], existing: Map<string, number>): KindPlan {
  const plan: KindPlan = { total: raws.length, valid: [], issues: [], conflicts: [], creates: 0 };
  raws.forEach((raw, index) => {
    const res = normalizeItem(raw);
    if (!res.ok) {
      plan.issues.push({
        index,
        title: str((raw as Record<string, unknown> | null)?.title).slice(0, 60),
        reason: res.reason,
      });
      return;
    }
    const hit = existing.get(res.item.slug);
    if (hit != null) plan.conflicts.push({ slug: res.item.slug, title: res.item.title, existingId: hit });
    plan.valid.push(res.item);
  });
  plan.creates = plan.valid.length - plan.conflicts.length;
  return plan;
}

export async function loadExistingSlugs(kind: ImportKind): Promise<Map<string, number>> {
  const table = kind === "post" ? posts : pagesTable;
  const rows = await db.select({ id: table.id, slug: table.slug }).from(table);
  return new Map(rows.map((r) => [r.slug, r.id]));
}

export async function buildImportPlan(text: string): Promise<ImportPlan> {
  const parsed = parseImportText(text);
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
  };
}

function summarizeKind(p: KindPlan) {
  return { total: p.total, valid: p.valid.length, issues: p.issues.length, conflicts: p.conflicts.length, creates: p.creates };
}

export function summarizePlan(plan: ImportPlan) {
  return { format: plan.format, posts: summarizeKind(plan.posts), pages: summarizeKind(plan.pages) };
}

export type ApplyResult = {
  posts: { created: number; updated: number; skipped: number };
  pages: { created: number; updated: number; skipped: number };
  errors: string[];
};

async function applyKind(
  user: SessionUser,
  kind: ImportKind,
  plan: KindPlan,
  policy: ImportPolicy,
  errors: string[],
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of plan.valid) {
    const hit = plan.conflicts.find((c) => c.slug === item.slug);
    try {
      if (hit) {
        if (policy === "skip") {
          skipped++;
          continue;
        }
        if (kind === "post") await updatePost(user, hit.existingId, item);
        else await updatePage(user, hit.existingId, item);
        updated++;
      } else {
        if (kind === "post") await createPost(user, item);
        else await createPage(user, item);
        created++;
      }
    } catch (e) {
      const msg = e instanceof ServiceError ? e.message : String(e);
      errors.push(`${item.title}：${msg}`);
      log.warn("import item failed", { kind, slug: item.slug, err: msg });
    }
  }
  return { created, updated, skipped };
}

export async function applyImport(
  user: SessionUser,
  plan: ImportPlan,
  policy: ImportPolicy,
): Promise<ApplyResult> {
  const errors: string[] = [];
  const [posts, pages] = [
    await applyKind(user, "post", plan.posts, policy, errors),
    await applyKind(user, "page", plan.pages, policy, errors),
  ];
  await invalidateContentCaches();
  return { posts, pages, errors };
}
