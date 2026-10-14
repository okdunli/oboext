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

function entryMeta(e: Record<string, unknown>): string {
  const lines = [
    `- 别名：${String(e.slug ?? "")}`,
    `- 状态：${String(e.status ?? "")}`,
    e.createdAt ? `- 创建时间：${new Date(e.createdAt as string).toISOString()}` : null,
    e.updatedAt ? `- 更新时间：${new Date(e.updatedAt as string).toISOString()}` : null,
    e.excerpt ? `- 摘要：${String(e.excerpt).replace(/\r?\n/g, " ")}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function toMarkdown(data: Record<string, unknown>): string {
  const out: string[] = [
    "# oboext 内容导出",
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
          `## ${String(p.title)}`,
          "",
          entryMeta(p),
          cats ? `- 分类：${cats}` : null,
          tags ? `- 标签：${tags}` : null,
          "",
          blocksToMarkdown((p.content as Block[]) ?? []),
          "",
          "---",
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
        `## ${String(p.title)}`,
        "",
        entryMeta(p),
        "",
        blocksToMarkdown((p.content as Block[]) ?? []),
        "",
        "---",
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
    data.posts = await paginate((offset) => listPosts({ limit: 100, offset, full: true }), 100);
  }
  if (scopes.includes("pages")) {

    const rows = await paginate((offset) => adminListPages(user, { limit: 100, offset }), 100);
    data.pages = await Promise.all(rows.map((p) => adminGetPage(user, p.id)));
  }
  if (scopes.includes("comments")) {

    data.comments = await rawQuery<Record<string, unknown>>(
      `SELECT id, post_id AS "postId", post_type AS "postType", status,
              author_name AS "authorName", content, created_at AS "createdAt"
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
