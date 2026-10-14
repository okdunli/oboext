/**
 * Widget service — ported from lib/widgets/registry.ts + lib/services/widgets.ts.
 *
 * A widget TYPE declares a settings schema (this static registry); a widget
 * INSTANCE (a row in `widgets`) binds a type into a theme-declared area with a
 * title, order and per-instance config. Public pages resolve enabled widgets
 * per area on every request (config defaults merged, data fetched live, URLs
 * resolved against current permalink config). No snapshots, no cross-request
 * caches.
 *
 * Trade-off: plugins (HOOKS.widgetTypes), multi-theme discovery and the
 * public-cache TTL are not ported yet — one shipped theme ("skyscraper"),
 * registry is static. Wire them in with p11 themes/plugins.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "./db.js";
import { memoQuery, SIDEBAR_TTL } from "./cache.js";
import {
  categories,
  comments,
  postCategories,
  posts,
  postTags,
  tags,
  widgets,
  type Widget,
} from "./schema.js";
import type { SessionUser } from "./auth.js";
import { requireCap, ServiceError } from "./admin.js";
import {
  getPermalinkConfig,
  postUrlFor,
  categoryUrlFor,
  tagUrlFor,
  type PermalinkConfig,
} from "./links.js";

export type WidgetField = {
  key: string;
  label: string;
  type: string;
  default?: unknown;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  half?: boolean;
  showIf?: { key: string; equals: string | string[] };
};

export type WidgetTypeDef = {
  type: string;
  label: string;
  description: string;
  /** lucide-react icon name for the admin picker. */
  icon: string;
  settings: { key: string; label: string; fields: WidgetField[] }[];
};

export const WIDGET_TYPES: WidgetTypeDef[] = [
  {
    type: "recent-posts",
    label: "最新文章",
    description: "按发布时间倒序列出最近的文章",
    icon: "FileText",
    settings: [
      {
        key: "main",
        label: "选项",
        fields: [
          { key: "count", label: "显示数量", type: "number", default: 5, min: 1, max: 30, half: true },
          { key: "showDate", label: "显示日期", type: "switch", default: true, half: true },
          { key: "showThumb", label: "显示缩略图", type: "switch", default: false },
          { key: "category", label: "限定分类 slug", type: "text", default: "", placeholder: "留空为全部" },
        ],
      },
    ],
  },
  {
    type: "popular-posts",
    label: "热门文章",
    description: "按阅读量排序的文章列表",
    icon: "Flame",
    settings: [
      {
        key: "main",
        label: "选项",
        fields: [
          { key: "count", label: "显示数量", type: "number", default: 5, min: 1, max: 30, half: true },
          { key: "showViews", label: "显示阅读量", type: "switch", default: true, half: true },
        ],
      },
    ],
  },
  {
    type: "categories",
    label: "分类目录",
    description: "列出全部分类，可显示文章数",
    icon: "Folder",
    settings: [
      {
        key: "main",
        label: "选项",
        fields: [
          { key: "showCount", label: "显示文章数", type: "switch", default: true, half: true },
          { key: "hideEmpty", label: "隐藏空分类", type: "switch", default: false, half: true },
        ],
      },
    ],
  },
  {
    type: "tag-cloud",
    label: "标签云",
    description: "标签云，字号随文章数变化",
    icon: "Tags",
    settings: [
      {
        key: "main",
        label: "选项",
        fields: [
          { key: "count", label: "最多显示", type: "number", default: 30, min: 5, max: 200, half: true },
          { key: "scale", label: "字号缩放", type: "switch", default: true, half: true },
        ],
      },
    ],
  },
  {
    type: "search",
    label: "搜索框",
    description: "站内搜索输入框",
    icon: "Search",
    settings: [
      {
        key: "main",
        label: "选项",
        fields: [
          { key: "placeholder", label: "占位文案", type: "text", default: "搜索文章…" },
        ],
      },
    ],
  },
  {
    type: "archive",
    label: "文章归档",
    description: "按年月归档的文章数量列表",
    icon: "CalendarDays",
    settings: [
      {
        key: "main",
        label: "选项",
        fields: [
          {
            key: "mode",
            label: "归档粒度",
            type: "select",
            default: "month",
            options: [
              { value: "month", label: "按月" },
              { value: "year", label: "按年" },
            ],
            half: true,
          },
          { key: "showCount", label: "显示数量", type: "switch", default: true, half: true },
          { key: "limit", label: "最多显示", type: "number", default: 12, min: 1, max: 120 },
        ],
      },
    ],
  },
  {
    type: "text",
    label: "文本 / HTML",
    description: "自由文本，支持 HTML 与短代码",
    icon: "Type",
    settings: [
      {
        key: "main",
        label: "内容",
        fields: [
          {
            key: "body",
            label: "内容",
            type: "code",
            default: "",
            help: "支持 HTML 与短代码，例如 [button href=\"/about\"]关于[/button]",
          },
        ],
      },
    ],
  },
  {
    type: "profile",
    label: "个人名片",
    description: "头像 + 简介 + 社交链接",
    icon: "UserCircle",
    settings: [
      {
        key: "main",
        label: "资料",
        fields: [
          { key: "avatar", label: "头像", type: "image", default: "" },
          { key: "name", label: "昵称", type: "text", default: "", half: true },
          { key: "role", label: "一句话身份", type: "text", default: "", half: true },
          { key: "bio", label: "简介", type: "textarea", default: "" },
          { key: "links", label: "社交链接", type: "links", default: [] },
        ],
      },
    ],
  },
  {
    type: "recent-comments",
    label: "最新评论",
    description: "展示最近通过审核的评论",
    icon: "MessageSquare",
    settings: [
      {
        key: "main",
        label: "选项",
        fields: [
          { key: "count", label: "显示数量", type: "number", default: 5, min: 1, max: 20, half: true },
          { key: "excerptLength", label: "摘要长度", type: "number", default: 48, half: true },
        ],
      },
    ],
  },
  {
    type: "links",
    label: "友情链接",
    description: "自定义链接列表",
    icon: "Link2",
    settings: [
      {
        key: "main",
        label: "链接",
        fields: [{ key: "items", label: "链接列表", type: "links", default: [] }],
      },
    ],
  },
  {
    type: "stats",
    label: "站点统计",
    description: "文章 / 分类 / 标签 / 评论 / 总阅读量",
    icon: "BarChart3",
    settings: [
      {
        key: "main",
        label: "选项",
        fields: [
          { key: "showPosts", label: "文章数", type: "switch", default: true, half: true },
          { key: "showComments", label: "评论数", type: "switch", default: true, half: true },
          { key: "showViews", label: "总阅读量", type: "switch", default: true, half: true },
          { key: "showRuntime", label: "运行天数", type: "switch", default: false, half: true },
          {
            key: "since",
            label: "建站日期",
            type: "text",
            default: "",
            placeholder: "2024-01-01",
            showIf: { key: "showRuntime", equals: "true" },
          },
        ],
      },
    ],
  },
];

export function getWidgetType(type: string): WidgetTypeDef | null {
  return WIDGET_TYPES.find((w) => w.type === type) ?? null;
}

/**
 * Theme widget areas. The only shipped theme is skyscraper, whose manifest
 * declares both base areas with themed labels; p11 will read manifests.
 */
export const THEME_SLUG = "skyscraper";

export const WIDGET_AREAS: { key: string; label: string; description?: string }[] = [
  { key: "sidebar", label: "左侧栏", description: "固定左侧栏的组件区域" },
  { key: "footer", label: "页脚", description: "页脚链接区" },
];

/** Merge stored values over schema defaults, dropping unknown keys. */
export function resolveSettings(
  def: WidgetTypeDef | null,
  stored: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const fields = def ? def.settings.flatMap((s) => s.fields) : [];
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined) out[f.key] = f.default;
  const known = new Set(fields.map((f) => f.key));
  for (const [k, v] of Object.entries(stored ?? {})) {
    if (known.has(k) && v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

export type WidgetInput = {
  area: string;
  type: string;
  title?: string;
  order?: number;
  enabled?: boolean;
  config?: Record<string, unknown>;
  themeSlug?: string;
};

export async function listWidgets(themeSlug = THEME_SLUG): Promise<Widget[]> {
  return db
    .select()
    .from(widgets)
    .where(eq(widgets.themeSlug, themeSlug))
    .orderBy(asc(widgets.area), asc(widgets.order));
}

export async function createWidget(user: SessionUser | null, input: WidgetInput): Promise<Widget> {
  requireCap(user, "settings:manage");
  if (!getWidgetType(input.type)) throw new ServiceError("未知的小工具类型", 422);
  const themeSlug = input.themeSlug || THEME_SLUG;
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${widgets.order}),0)` })
    .from(widgets)
    .where(and(eq(widgets.area, input.area), eq(widgets.themeSlug, themeSlug)));
  const [row] = await db
    .insert(widgets)
    .values({
      area: input.area,
      type: input.type,
      title: input.title ?? "",
      order: input.order ?? Number(maxRow?.max ?? 0) + 1,
      enabled: input.enabled ?? true,
      config: input.config ?? {},
      themeSlug,
    })
    .returning();
  return row;
}

export async function updateWidget(
  user: SessionUser | null,
  id: number,
  input: Partial<WidgetInput>,
): Promise<Widget> {
  requireCap(user, "settings:manage");
  const [existing] = await db.select().from(widgets).where(eq(widgets.id, id));
  if (!existing) throw new ServiceError("小工具不存在", 404);
  const [row] = await db
    .update(widgets)
    .set({
      area: input.area ?? existing.area,
      title: input.title ?? existing.title,
      order: input.order ?? existing.order,
      enabled: input.enabled ?? existing.enabled,
      config: input.config ? { ...existing.config, ...input.config } : existing.config,
    })
    .where(eq(widgets.id, id))
    .returning();
  return row;
}

export async function deleteWidget(user: SessionUser | null, id: number): Promise<{ id: number }> {
  requireCap(user, "settings:manage");
  const [existing] = await db.select({ id: widgets.id }).from(widgets).where(eq(widgets.id, id));
  if (!existing) throw new ServiceError("小工具不存在", 404);
  await db.delete(widgets).where(eq(widgets.id, id));
  return { id };
}

/** Persist a new ordering for one area in a single pass. */
export async function reorderWidgets(user: SessionUser | null, ids: number[]): Promise<void> {
  requireCap(user, "settings:manage");
  for (let i = 0; i < ids.length; i++) {
    await db.update(widgets).set({ order: i + 1 }).where(eq(widgets.id, ids[i]));
  }
}

export type ResolvedWidget = {
  id: number;
  type: string;
  title: string;
  config: Record<string, unknown>;
  data: unknown;
};

/** Load every enabled widget in an area with its data already fetched. */
export async function getAreaWidgets(
  themeSlug: string,
  area: string,
): Promise<ResolvedWidget[]> {
  const rows = await db
    .select()
    .from(widgets)
    .where(
      and(
        eq(widgets.area, area),
        eq(widgets.enabled, true),
        eq(widgets.themeSlug, themeSlug),
      ),
    )
    .orderBy(asc(widgets.order));

  const cfg = await getPermalinkConfig();
  const out: ResolvedWidget[] = [];
  for (const w of rows) {
    const def = getWidgetType(w.type);
    const config = resolveSettings(def, w.config);
    out.push({
      id: w.id,
      type: w.type,
      title: w.title,
      config,
      data: withWidgetUrls(w.type, await resolveWidgetData(w.type, config), cfg),
    });
  }
  return out;
}

/** Attach public URLs to entity rows carried by link-producing widgets. */
function withWidgetUrls(type: string, data: unknown, cfg: PermalinkConfig): unknown {
  if (!Array.isArray(data)) return data;
  if (type === "recent-posts" || type === "popular-posts")
    return data.map((r: { id: number; slug: string }) => ({ ...r, url: postUrlFor(cfg, r) }));
  if (type === "categories")
    return data.map((r: { slug: string }) => ({ ...r, url: categoryUrlFor(cfg, r) }));
  if (type === "tag-cloud")
    return data.map((r: { slug: string }) => ({ ...r, url: tagUrlFor(cfg, r) }));
  return data;
}

export async function resolveWidgetData(
  type: string,
  config: Record<string, unknown>,
): Promise<unknown> {
  const key = `widget:${type}:${JSON.stringify(config)}`;
  return memoQuery(key, SIDEBAR_TTL, () => resolveWidgetDataRaw(type, config));
}

async function resolveWidgetDataRaw(
  type: string,
  config: Record<string, unknown>,
): Promise<unknown> {
  const num = (k: string, d: number) => {
    const n = Number(config[k]);
    return Number.isFinite(n) && n > 0 ? n : d;
  };

  switch (type) {
    case "recent-posts": {
      const limit = num("count", 5);
      const catSlug = String(config.category ?? "").trim();
      if (catSlug) {
        return db
          .select({
            id: posts.id,
            title: posts.title,
            slug: posts.slug,
            publishedAt: posts.publishedAt,
            featuredImage: posts.featuredImage,
          })
          .from(posts)
          .innerJoin(postCategories, eq(postCategories.postId, posts.id))
          .innerJoin(categories, eq(categories.id, postCategories.categoryId))
          .where(and(eq(posts.status, "published"), eq(categories.slug, catSlug)))
          .orderBy(desc(posts.publishedAt))
          .limit(limit);
      }
      return db
        .select({
          id: posts.id,
          title: posts.title,
          slug: posts.slug,
          publishedAt: posts.publishedAt,
          featuredImage: posts.featuredImage,
        })
        .from(posts)
        .where(eq(posts.status, "published"))
        .orderBy(desc(posts.publishedAt))
        .limit(limit);
    }

    case "popular-posts":
      return db
        .select({
          id: posts.id,
          title: posts.title,
          slug: posts.slug,
          views: posts.views,
        })
        .from(posts)
        .where(eq(posts.status, "published"))
        .orderBy(desc(posts.views))
        .limit(num("count", 5));

    case "categories": {
      const rows = await db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          count: sql<number>`count(${postCategories.postId})`,
        })
        .from(categories)
        .leftJoin(postCategories, eq(postCategories.categoryId, categories.id))
        .groupBy(categories.id, categories.name, categories.slug)
        .orderBy(asc(categories.name));
      return config.hideEmpty ? rows.filter((r) => Number(r.count) > 0) : rows;
    }

    case "tag-cloud":
      return db
        .select({
          id: tags.id,
          name: tags.name,
          slug: tags.slug,
          count: sql<number>`count(${postTags.postId})`,
        })
        .from(tags)
        .leftJoin(postTags, eq(postTags.tagId, tags.id))
        .groupBy(tags.id, tags.name, tags.slug)
        .orderBy(desc(sql`count(${postTags.postId})`))
        .limit(num("count", 30));

    case "archive": {
      const byYear = String(config.mode ?? "month") === "year";
      const fmt = byYear ? "YYYY" : "YYYY-MM";
      const rows = await db
        .select({
          period: sql<string>`to_char(${posts.publishedAt}, ${sql.raw(`'${fmt}'`)})`,
          count: sql<number>`count(*)`,
        })
        .from(posts)
        .where(eq(posts.status, "published"))
        .groupBy(sql`to_char(${posts.publishedAt}, ${sql.raw(`'${fmt}'`)})`)
        .orderBy(desc(sql`to_char(${posts.publishedAt}, ${sql.raw(`'${fmt}'`)})`))
        .limit(num("limit", 12));
      return rows.filter((r) => !!r.period);
    }

    case "recent-comments":
      return db
        .select({
          id: comments.id,
          authorName: comments.authorName,
          content: comments.content,
          postId: comments.postId,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .where(eq(comments.status, "published"))
        .orderBy(desc(comments.createdAt))
        .limit(num("count", 5));

    case "stats": {
      const [p] = await db
        .select({
          posts: sql<number>`count(*)`,
          views: sql<number>`coalesce(sum(${posts.views}),0)`,
        })
        .from(posts)
        .where(eq(posts.status, "published"));
      const [c] = await db
        .select({ comments: sql<number>`count(*)` })
        .from(comments)
        .where(eq(comments.status, "published"));
      const [t] = await db.select({ tags: sql<number>`count(*)` }).from(tags);
      const [cat] = await db.select({ categories: sql<number>`count(*)` }).from(categories);
      return {
        posts: Number(p?.posts ?? 0),
        views: Number(p?.views ?? 0),
        comments: Number(c?.comments ?? 0),
        tags: Number(t?.tags ?? 0),
        categories: Number(cat?.categories ?? 0),
      };
    }

    default:
      return null;
  }
}
