// Oboext schema — ported verbatim from the original app (db/schema.ts).
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Structured editor content (mirror of lib/blocks.ts Block union). */
export type Block =
  | { id: string; type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "image"; url: string; alt?: string; caption?: string }
  | { id: string; type: "quote"; text: string; cite?: string; title?: string }
  | { id: string; type: "code"; language?: string; code: string }
  | { id: string; type: "list"; ordered?: boolean; items: string[] }
  | { id: string; type: "divider" }
  | { id: string; type: "html"; html: string };

export const roleEnum = pgEnum("role", ["admin", "editor", "author", "subscriber"]);
export const statusEnum = pgEnum("status", ["draft", "published", "archived"]);
export const commentStatusEnum = pgEnum("comment_status", ["open", "closed"]);
export const commentStateEnum = pgEnum("comment_state", ["published", "pending", "spam"]);

export const postFormatEnum = pgEnum("post_format", [
  "standard",
  "aside",
  "quote",
  "link",
  "image",
  "gallery",
  "video",
  "audio",
  "status",
]);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").unique(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: roleEnum("role").notNull().default("author"),
    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    phone: text("phone"),
    status: text("status").notNull().default("active"),
    emailVerified: boolean("email_verified").notNull().default(false),
    phoneVerified: boolean("phone_verified").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    phoneIdx: uniqueIndex("users_phone_idx").on(t.phone),
    nameIdx: uniqueIndex("users_name_idx").on(t.name),
  }),
);

export const oauthIdentities = pgTable(
  "oauth_identities",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    openId: text("open_id").notNull(),
    nickname: text("nickname"),
    avatarUrl: text("avatar_url"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    providerOpenIdx: uniqueIndex("oauth_identities_provider_open_idx").on(
      t.provider,
      t.openId,
    ),
    userIdx: index("oauth_identities_user_idx").on(t.userId),
  }),
);

export const verifyCodes = pgTable(
  "verify_codes",
  {
    id: serial("id").primaryKey(),
    target: text("target").notNull(),
    channel: text("channel").notNull(),
    purpose: text("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ targetIdx: index("verify_codes_target_idx").on(t.target, t.purpose) }),
);

export const securityEvents = pgTable(
  "security_events",
  {
    id: serial("id").primaryKey(),
    eventType: text("event_type").notNull(),
    userId: integer("user_id"),
    account: text("account"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeIdx: index("security_events_type_idx").on(t.eventType, t.createdAt),
    accountIdx: index("security_events_account_idx").on(t.account, t.createdAt),
  }),
);

const contentColumns = {
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  excerpt: text("excerpt"),
  content: jsonb("content").$type<Block[]>().notNull().default([]),
  status: statusEnum("status").notNull().default("draft"),
  featuredImage: text("featured_image"),
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  seoKeywords: text("seo_keywords"),
  commentStatus: commentStatusEnum("comment_status").notNull().default("open"),
  commentsCount: integer("comments_count").notNull().default(0),
  views: integer("views").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const posts = pgTable(
  "posts",
  {
    id: serial("id").primaryKey(),
    ...contentColumns,
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    format: postFormatEnum("format").notNull().default("standard"),
    pinned: boolean("pinned").notNull().default(false),
    template: text("template"),
    formatMeta: jsonb("format_meta").$type<Record<string, string>>().notNull().default({}),
    likes: integer("likes").notNull().default(0),
    uniqueViews: integer("unique_views").notNull().default(0),
    pinyinSlug: text("pinyin_slug"),
    initialSlug: text("initial_slug"),
  },
  (t) => ({
    slugIdx: uniqueIndex("posts_slug_idx").on(t.slug),
    statusIdx: index("posts_status_idx").on(t.status),
    pinnedIdx: index("posts_pinned_idx").on(t.pinned),
    // Declared to match db/migrations/0018 so a future `drizzle-kit generate` does not read them as missing and try to recreate them.
    statusPublishedIdx: index("posts_status_published_idx").on(t.status, t.publishedAt),
    // Declared to match db/migrations/0020: the admin listings sort by
    // (updated_at DESC, id DESC) after filtering on status.
    statusUpdatedIdx: index("posts_status_updated_idx").on(t.status, t.updatedAt, t.id),
    viewsIdx: index("posts_views_idx").on(t.views, t.publishedAt),
    likesIdx: index("posts_likes_idx").on(t.likes, t.publishedAt),
    commentsIdx: index("posts_comments_idx").on(t.commentsCount, t.publishedAt),
    pinyinIdx: uniqueIndex("posts_pinyin_slug_idx").on(t.pinyinSlug),
    initialIdx: uniqueIndex("posts_initial_slug_idx").on(t.initialSlug),
  }),
);

export const postVisitors = pgTable(
  "post_visitors",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    visitorKey: text("visitor_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: uniqueIndex("post_visitors_pk").on(t.postId, t.visitorKey) }),
);

export const pages = pgTable(
  "pages",
  {
    id: serial("id").primaryKey(),
    ...contentColumns,
    parentId: integer("parent_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    template: text("template"),
    order: integer("order").notNull().default(0),
  },
  (t) => ({
    slugIdx: uniqueIndex("pages_slug_idx").on(t.slug),
    statusIdx: index("pages_status_idx").on(t.status),
    // Declared to match db/migrations/0020: the admin pages listing sorts by
    // (updated_at DESC, id DESC) after filtering on status.
    statusUpdatedIdx: index("pages_status_updated_idx").on(t.status, t.updatedAt, t.id),
  }),
);

export const media = pgTable(
  "media",
  {
    id: serial("id").primaryKey(),
    filename: text("filename").notNull(),
    url: text("url").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull().default(0),
    width: integer("width"),
    height: integer("height"),
    alt: text("alt"),
    tags: text("tags"),
    sortOrder: integer("sort_order").notNull().default(0),
    uploadedById: integer("uploaded_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ mimeIdx: index("media_mime_idx").on(t.mimeType) }),
);

export const categories = pgTable(
  "categories",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    icon: text("icon"),
    parentId: integer("parent_id"),
    order: integer("order").notNull().default(0),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    seoKeywords: text("seo_keywords"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ slugIdx: uniqueIndex("categories_slug_idx").on(t.slug) }),
);

export const tags = pgTable(
  "tags",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    seoKeywords: text("seo_keywords"),
  },
  (t) => ({ slugIdx: uniqueIndex("tags_slug_idx").on(t.slug) }),
);

export const postTags = pgTable(
  "post_tags",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  // See postCategories for why the second column needs its own index.
  (t) => ({
    pk: uniqueIndex("post_tags_pk").on(t.postId, t.tagId),
  }),
);

export const postCategories = pgTable(
  "post_categories",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  // Category_id / tag_id need NO extra index: EXPLAIN shows the sibling lookups in queries.ts (~513) already served by the composite pk via a //.
  (t) => ({ pk: uniqueIndex("post_categories_pk").on(t.postId, t.categoryId) }),
);

// Content revision history: one pre-update snapshot per save of a post/page,
// written by revisions.ts from inside create/update (never from the route
// layer, so the admin editor, the server-side autosave and restore itself all
// produce history). Retention is capped by pruneRevisions (OBOEXT_REVISION_KEEP).
export const contentRevisions = pgTable(
  "content_revisions",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").$type<"post" | "page">().notNull(),
    targetId: integer("target_id").notNull(),
    authorId: integer("author_id"),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    content: jsonb("content").$type<Block[]>().notNull().default([]),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetIdx: index("content_revisions_target_idx").on(t.kind, t.targetId, t.id),
  }),
);

export const comments = pgTable(
  "comments",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id").notNull(),
    postType: text("post_type").notNull().default("post"),
    parentId: integer("parent_id"),
    userId: integer("user_id"),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email"),
    authorUrl: text("author_url"),
    content: text("content").notNull(),
    status: commentStateEnum("status").notNull().default("pending"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    postIdx: index("comments_post_idx").on(t.postId, t.postType),
    statusIdx: index("comments_status_idx").on(t.status),
  }),
);

export const menus = pgTable("menus", {
  id: serial("id").primaryKey(),
  location: text("location").notNull().unique(),
  name: text("name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const menuItems = pgTable(
  "menu_items",
  {
    id: serial("id").primaryKey(),
    menuId: integer("menu_id")
      .notNull()
      .references(() => menus.id, { onDelete: "cascade" }),
    parentId: integer("parent_id"),
    order: integer("order").notNull().default(0),
    type: text("type").notNull().default("custom"),
    label: text("label").notNull(),
    url: text("url").notNull().default(""),
    referenceId: integer("reference_id"),
    referenceSlug: text("reference_slug"),
    target: text("target").notNull().default("_self"),
    icon: text("icon"),
  },
  (t) => ({ menuIdx: index("menu_items_menu_idx").on(t.menuId) }),
);

export const postMetas = pgTable(
  "post_metas",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value"),
  },
  (t) => ({ postIdx: index("post_metas_post_idx").on(t.postId) }),
);

export const pageMetas = pgTable(
  "page_metas",
  {
    id: serial("id").primaryKey(),
    pageId: integer("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value"),
  },
  (t) => ({ pageIdx: index("page_metas_page_idx").on(t.pageId) }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type Media = typeof media.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
export type ContentStatus = (typeof statusEnum.enumValues)[number];

export type SocialLink = { label: string; url: string; icon?: string };
export type FooterLink = { text: string; url: string; image?: string };

export const siteSettings = pgTable("site_settings", {
  id: integer("id").primaryKey(),
  siteTitle: text("site_title").notNull().default("oboext"),
  siteDescription: text("site_description")
    .notNull()
    .default("一个 Serverless 友好的内容管理系统"),
  tagline: text("tagline"),
  logoUrl: text("logo_url"),
  faviconUrl: text("favicon_url"),
  activeThemeSlug: text("active_theme_slug").notNull().default("default"),
  footerText: text("footer_text"),
  commentsEnabled: boolean("comments_enabled").notNull().default(true),
  requireNameEmail: boolean("require_name_email").notNull().default(false),
  // Whether a guest comment must carry a link.
  requireAuthorUrl: boolean("require_author_url").notNull().default(false),
  commentModeration: boolean("comment_moderation").notNull().default(false),
  commentModerationWords: text("comment_moderation_words").notNull().default(""),
  commentDefaultContent: text("comment_default_content").notNull().default(""),
  commentProvider: text("comment_provider").notNull().default("builtin"),
  artalkServer: text("artalk_server").notNull().default(""),
  artalkSite: text("artalk_site").notNull().default(""),
  giscusRepo: text("giscus_repo").notNull().default(""),
  giscusRepoId: text("giscus_repo_id").notNull().default(""),
  giscusCategory: text("giscus_category").notNull().default("General"),
  giscusCategoryId: text("giscus_category_id").notNull().default(""),
  giscusMapping: text("giscus_mapping").notNull().default("pathname"),
  giscusReactions: boolean("giscus_reactions").notNull().default(true),
  giscusTheme: text("giscus_theme").notNull().default(""),
  walineServer: text("waline_server").notNull().default(""),
  twikooEnvId: text("twikoo_env_id").notNull().default(""),
  disqusShortname: text("disqus_shortname").notNull().default(""),
  utterancesRepo: text("utterances_repo").notNull().default(""),
  utterancesTerm: text("utterances_term").notNull().default("pathname"),
  avatarSource: text("avatar_source").notNull().default("gravatar"),
  avatarSize: integer("avatar_size").notNull().default(80),
  avatarDefault: text("avatar_default").notNull().default("identicon"),
  avatarRating: text("avatar_rating").notNull().default("g"),
  homeDisplay: text("home_display").notNull().default("latest"),
  homePageId: integer("home_page_id"),
  postsPageId: integer("posts_page_id"),
  postsPerPage: integer("posts_per_page").notNull().default(10),
  feedItems: integer("feed_items").notNull().default(20),
  feedContent: text("feed_content").notNull().default("excerpt"),
  excerptLength: integer("excerpt_length").notNull().default(160),
  seoTitleTemplate: text("seo_title_template").notNull().default("%title% - %site%"),
  seoKeywords: text("seo_keywords").notNull().default(""),
  seoDefaultDescription: text("seo_default_description").notNull().default(""),
  seoRobots: text("seo_robots").notNull().default("index,follow"),
  ogImageUrl: text("og_image_url"),
  twitterCard: text("twitter_card").notNull().default("summary_large_image"),
  twitterSite: text("twitter_site"),
  verifications: jsonb("verifications").$type<Record<string, string>>().notNull().default({}),
  customHead: text("custom_head").notNull().default(""),
  customFooter: text("custom_footer").notNull().default(""),
  customCss: text("custom_css").notNull().default(""),
  analyticsId: text("analytics_id"),
  icpNumber: text("icp_number"),
  socialLinks: jsonb("social_links").$type<SocialLink[]>().notNull().default([]),
  footerLinks: jsonb("footer_links").$type<FooterLink[]>().notNull().default([]),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  dateFormat: text("date_format").notNull().default("YYYY-MM-DD"),
  language: text("language").notNull().default("zh-CN"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const options = pgTable(
  "options",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").$type<unknown>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ keyIdx: uniqueIndex("options_key_idx").on(t.key) }),
);

export const plugins = pgTable(
  "plugins",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    version: text("version").notNull().default("1.0.0"),
    author: text("author").notNull().default(""),
    enabled: boolean("enabled").notNull().default(false),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ slugIdx: uniqueIndex("plugins_slug_idx").on(t.slug) }),
);

export const widgets = pgTable("widgets", {
  id: serial("id").primaryKey(),
  area: text("area").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull().default(""),
  order: integer("order").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  themeSlug: text("theme_slug").notNull().default(""),
});

export type ThemeConfig = {
  background?: string;
  surface?: string;
  surfaceAlt?: string;
  text?: string;
  muted?: string;
  accent?: string;
  accentText?: string;
  accentSoft?: string;
  border?: string;
  link?: string;
  linkHover?: string;
  success?: string;
  warning?: string;
  danger?: string;
  headerBg?: string;
  footerBg?: string;
  codeBg?: string;
  radius?: string;
  radiusLarge?: string;
  borderWidth?: string;
  shadow?: string;
  transition?: string;
  font?: string;
  fontHeading?: string;
  fontMono?: string;
  fontSize?: string;
  lineHeight?: string;
  letterSpacing?: string;
  headingWeight?: string;
  containerWidth?: string;
  contentWidth?: string;
  sidebar?: string;
  density?: string;
  listStyle?: string;
  gridColumns?: string;
  headerMode?: string;
  glass?: string;
  glassBlur?: string;
  noise?: string;
  gradient?: string;
  colorScheme?: string;
  customCss?: string;
};

export const themes = pgTable(
  "themes",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    config: jsonb("config").$type<ThemeConfig>().notNull().default({}),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ slugIdx: uniqueIndex("themes_slug_idx").on(t.slug) }),
);

export type SiteSettings = typeof siteSettings.$inferSelect;
export type Theme = typeof themes.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Menu = typeof menus.$inferSelect;
export type MenuItem = typeof menuItems.$inferSelect;
export type PostMeta = typeof postMetas.$inferSelect;
export type Option = typeof options.$inferSelect;
export type Plugin = typeof plugins.$inferSelect;
export type Widget = typeof widgets.$inferSelect;
export type PostFormat = (typeof postFormatEnum.enumValues)[number];
