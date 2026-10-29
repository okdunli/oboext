// Oboext schema — ported verbatim from the original app (db/schema.ts).
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  boolean,
  date,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    // True when the account has no password (OAuth/passwordless signup). A
    // per-row column, not the old shared oauth.nopassword option array, so the
    // mark is an atomic single-row UPDATE with no read-modify-write race.
    passwordless: boolean("passwordless").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    phoneIdx: uniqueIndex("users_phone_idx").on(t.phone),
    nameIdx: uniqueIndex("users_name_idx").on(t.name),
    // Login folds both sides before comparing (auth.ts: lower(email) =
    // lower($1)), which no plain index can serve, so the folded expression is
    // what gets indexed. Mirrors migration 0029 verbatim. Deliberately not
    // unique: legacy rows may hold both Alice@ and alice@, and a unique
    // expression index would then fail to build.
    emailLowerIdx: index("users_email_lower_idx").on(sql`lower(${t.email})`),
    nameLowerIdx: index("users_name_lower_idx").on(sql`lower(${t.name})`),
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
  (t) => ({
    targetIdx: index("verify_codes_target_idx").on(t.target, t.purpose),
    // Serves the per-IP hourly send cap (issueCode: COUNT by ip in a 1h window).
    ipCreatedIdx: index("verify_codes_ip_created_idx").on(t.ip, t.createdAt),
  }),
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
    // Mirrors migration 0030. The throttle check folds the account (a
    // case-sensitive counter would let "Alice"/"alice" each keep their own) and
    // orders by id DESC, so the keys are the folded expression and the raw ip,
    // each with id second. The (account, created_at) index these replace had no
    // consumer: nothing in the codebase compares the raw account.
    accountLowerIdx: index("security_events_account_lower_idx").on(sql`lower(${t.account})`, t.id),
    ipIdx: index("security_events_ip_idx").on(t.ip, t.id),
  }),
);

const contentColumns = {
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  excerpt: text("excerpt"),
  content: jsonb("content").$type<Block[]>().notNull().default([]),
  // R200: a plain-text projection of `content` so full-text search can match
  // words that live in the article BODY, not just the title/excerpt. The jsonb
  // body is kept for rendering/export; this column is the searchable form.
  bodyPlain: text("body_plain"),
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
    // R272: the post's content language (i18n.ts LOCALES). DATA ONLY for now —
    // nothing in the render path reads it (R269's canonical merge stays) —
    // so existing rows land at the default via NOT NULL DEFAULT 'zh-CN'
    // (0042) and later rounds build pairing + admin UI on top without a
    // second table rewrite.
    locale: text("locale").notNull().default("zh-CN"),
    // R273: the post this row translates (0043). NULL for default-locale
    // originals; a non-default post without a pair is simply untranslated.
    // ON DELETE SET NULL keeps the translation alive when its original dies.
    translationOf: integer("translation_of").references((): any => posts.id, { onDelete: "set null" }),
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
    // Declared to match db/migrations/0028: an author's published list filters
    // author_id and orders by published_at, and a status-only index makes the
    // planner read every other author's rows first. ASC so a backward scan
    // answers "published_at DESC".
    authorIdx: index("posts_author_idx").on(t.authorId, t.publishedAt),
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
    // db/migrations/0041: provenance of the landing visit. Host only (a full
    // URL can carry a search phrase), and nullable because rows written before
    // the migration - and every caller that passes no referrer - have none.
    referrerHost: text("referrer_host"),
    referrerKind: text("referrer_kind"),
  },
  (t) => ({
    pk: uniqueIndex("post_visitors_pk").on(t.postId, t.visitorKey),
    // 0041: the daily rollup reads `created_at >= current_date - 1` on every
    // minute tick; neither (post_id, visitor_key) nor the visit_daily PK can
    // answer that predicate, so without this btree it is a whole-table scan of
    // a ledger that nothing prunes.
    createdIdx: index("post_visitors_created_idx").on(t.createdAt),
  }),
);

/** Daily traffic by source (db/migrations/0041). Written ONLY by the sweeper's
 *  rollup, never on the request path: the aggregation upserts the absolute
 *  counts for a day, so a rerun (or a second instance) cannot double them. */
export const visitDaily = pgTable(
  "visit_daily",
  {
    day: date("day").notNull(),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    referrerKind: text("referrer_kind").notNull(),
    views: integer("views").notNull().default(0),
    uniques: integer("uniques").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.day, t.postId, t.referrerKind] }) }),
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
  (t) => ({
    mimeIdx: index("media_mime_idx").on(t.mimeType),
    // Serves the media library's default ordering (listMedia: sortOrder ASC,
    // createdAt DESC) so the admin grid is not a full sort over the table.
    sortIdx: index("media_sort_idx").on(t.sortOrder, t.createdAt),
  }),
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
    // Serves the guest-comment flood check (createPublicComment: COUNT by ip in
    // a recent window) on the comment-write hot path.
    ipCreatedIdx: index("comments_ip_created_idx").on(t.ip, t.createdAt),
  }),
);

export const commentLikes = pgTable(
  "comment_likes",
  {
    id: serial("id").primaryKey(),
    commentId: integer("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    visitorKey: text("visitor_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex("comment_likes_comment_visitor_pk").on(t.commentId, t.visitorKey),
    commentIdx: index("comment_likes_comment_idx").on(t.commentId),
  }),
);

// Post likes (db/migrations/0040): same one-row-per-(post, visitor) shape as
// comment_likes above. posts.likes stays the denormalized counter (the admin
// lists and rankings order by it); this table is what makes the increment
// idempotent - UNIQUE(post_id, visitor_key) lets post-likes.ts tie
// `posts.likes + 1` to "this statement really inserted" in ONE statement.
export const postLikes = pgTable(
  "post_likes",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    visitorKey: text("visitor_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex("post_likes_post_visitor_pk").on(t.postId, t.visitorKey),
    postIdx: index("post_likes_post_idx").on(t.postId),
    visitorIdx: index("post_likes_visitor_idx").on(t.visitorKey),
  }),
);

// Newsletter (db/migrations/0035). state is the (confirmed_at,
// unsubscribed_at) timestamp pair, not an enum: a re-subscribe after an
// unsubscribe is an UPDATE on the surviving row and UNIQUE(email) holds across
// confirm/unsubscribe cycles. token doubles as the double-opt-in credential
// and the one-click unsubscribe credential.
export const subscribers = pgTable("subscribers", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  locale: text("locale").notNull().default("zh-CN"),
  token: text("token").notNull().unique(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-(post, subscriber) send ledger. enqueueSweep claims a pair with
// INSERT ... ON CONFLICT DO NOTHING; only the insert that landed fires the
// mail, so a concurrent pass (or a second instance) cannot double-send and a
// re-run after a crash skips anything already claimed.
//
// failedAt (db/migrations/0036): the claim lands BEFORE the SMTP session, so
// a claimed row is not evidence of a delivered mail. NULL = delivered (or
// never attempted because SMTP is unconfigured); a timestamp = the delivery
// failed and the row is eligible for the retry pass.
export const newsletterSends = pgTable(
  "newsletter_sends",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    subscriberId: integer("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (t) => ({
    pk: uniqueIndex("newsletter_sends_post_subscriber_pk").on(t.postId, t.subscriberId),
    subscriberIdx: index("newsletter_sends_subscriber_idx").on(t.subscriberId),
  }),
);

export type Subscriber = typeof subscribers.$inferSelect;

export const menus = pgTable("menus", {  id: serial("id").primaryKey(),
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
  siteTitle: text("site_title").notNull().default("Oboext"),
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

/**
 * R193: custom redirects (db/migrations/0031). Declared with the folded unique
 * index so the matcher's `lower(source) = lower(path)` predicate is an index
 * descent; `auto` separates a rename the software guessed from a rule the
 * operator typed.
 */
export const redirects = pgTable(
  "redirects",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    target: text("target").notNull(),
    permanent: boolean("permanent").notNull().default(true),
    auto: boolean("auto").notNull().default(false),
    hits: integer("hits").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceLowerIdx: uniqueIndex("redirects_source_lower_idx").on(sql`lower(${t.source})`),
  }),
);

/**
 * Search-term telemetry (db/migrations/0038): one row per (term, locale), the
 * upsert target of recordSearchTerm's ON CONFLICT. hits/last_at mirror the
 * admin hot-terms ORDER BY (hits DESC, last_at DESC) so /admin/search-terms is
 * an index walk, not a sort. Declared to match migration 0038 verbatim.
 */
export const searchTerms = pgTable(
  "search_terms",
  {
    id: serial("id").primaryKey(),
    term: text("term").notNull(),
    locale: text("locale").notNull().default("zh-CN"),
    hits: integer("hits").notNull().default(1),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    termLocalePk: unique("search_terms_term_locale_pk").on(t.term, t.locale),
    hitsLastIdx: index("search_terms_hits_last_idx").on(t.hits.desc(), t.lastAt.desc()),
    lastAtIdx: index("search_terms_last_at_idx").on(t.lastAt.desc()),
  }),
);

/**
 * Webmention ledger (db/migrations/0039): one row per (source, target) pair the
 * receiver was told about. The unique pair is the idempotency key - a re-sent
 * mention claims nothing new - and `status` records the verdict of the
 * background verification (pending -> accepted | rejected). comment_id is a
 * deliberately bare integer: comments are hard-deleted from the admin, and an
 * FK cascade would erase the evidence the mention arrived at all.
 */
export const webmentions = pgTable(
  "webmentions",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    target: text("target").notNull(),
    postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    commentId: integer("comment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceTargetPk: unique("webmentions_source_target_pk").on(t.source, t.target),
    postIdx: index("webmentions_post_idx").on(t.postId),
  }),
);

export type SearchTerm = typeof searchTerms.$inferSelect;
export type Webmention = typeof webmentions.$inferSelect;
export type Redirect = typeof redirects.$inferSelect;
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
