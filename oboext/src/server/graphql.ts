import { buildSchema, GraphQLError } from "graphql";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "./db.js";
import { categories, media, pages, posts, tags, users } from "./schema.js";
import {
  getSessionFromRequest,
  signChallengeTicket,
  signSession,
  verifyChallengeTicket,
  verifyCredentials,
  assertLoginAllowed,
  clearLoginFailures,
  recordLoginEvent,
  LOGIN_EVENTS,
  clientIp,
  clientUa,
  LoginThrottledError,
  type SessionUser,
} from "./auth.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { normalizeLocale } from "./i18n.js";
import { HOOKS, applyAsyncFilters } from "./hooks.js";
import { ServiceError } from "./errors.js";
import { getTwoFaState, verifyTwoFaCode } from "./twofa.js";
import { roleAllows } from "./admin-menu.js";
import { attachTaxonomies, listCategories, listPosts, listTags } from "./queries.js";
import { offsetNum } from "./paging.js";
import { listMedia } from "./media.js";
import { adminListUsers } from "./admin.js";
import {
  createCategory,
  createPost,
  createTag,
  deleteCategory,
  deletePost,
  deleteTag,
  updateCategory,
  updatePost,
  updateTag,
} from "./admin.js";
import { createPage, deletePage, updatePage } from "./pages.js";

// ---- Type definitions ----

const typeDefs = /* GraphQL */ `
  scalar JSON
  scalar DateTime

  type User {
    id: Int!
    email: String
    name: String!
    role: String!
    bio: String
    avatarUrl: String
    createdAt: DateTime
  }

  type Category {
    id: Int!
    name: String!
    slug: String!
    description: String
    icon: String
    parentId: Int
  }

  type Tag {
    id: Int!
    name: String!
    slug: String!
  }

  type Media {
    id: Int!
    filename: String!
    url: String!
    mimeType: String!
    size: Int!
    alt: String
    createdAt: DateTime
  }

  type Post {
    id: Int!
    title: String!
    slug: String!
    excerpt: String
    content: JSON!
    status: String!
    featuredImage: String
    seoTitle: String
    seoDescription: String
    seoKeywords: String
    author: User
    categories: [Category!]!
    tags: [Tag!]!
    publishedAt: DateTime
    createdAt: DateTime
    updatedAt: DateTime
    "R278: the post's content language (i18n LOCALES)."
    locale: String!
    "R278: id of the post this row translates; null for originals. Any signed-in reader may see it — pairing is public metadata, not a draft state."
    translationOf: Int
  }

  type Page {
    id: Int!
    title: String!
    slug: String!
    excerpt: String
    content: JSON!
    status: String!
    featuredImage: String
    seoTitle: String
    seoDescription: String
    seoKeywords: String
    parentId: Int
    publishedAt: DateTime
    createdAt: DateTime
    updatedAt: DateTime
    "0045: the page's content language."
    locale: String!
    "0046: id of the page this row translates; null for originals."
    translationOf: Int
    "0046: the page this one translates, or the translation of it."
    translationOriginal: Page
  }

  type PostList {
    items: [Post!]!
    total: Int!
  }
  type PageList {
    items: [Page!]!
    total: Int!
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  input PostInput {
    title: String!
    slug: String
    excerpt: String
    content: JSON
    status: String
    featuredImage: String
    seoTitle: String
    seoDescription: String
    seoKeywords: String
    authorId: Int
    categoryIds: [Int!]
    tagIds: [Int!]
    "R278: the content language; defaults to the site default."
    locale: String
    "R278: id of the post this row translates."
    translationOf: Int
  }

  input PageInput {
    title: String!
    slug: String
    excerpt: String
    content: JSON
    status: String
    featuredImage: String
    seoTitle: String
    seoDescription: String
    seoKeywords: String
    parentId: Int
    categoryIds: [Int!]
    tagIds: [Int!]
    "0045: the content language; defaults to the site default."
    locale: String
    "0046: id of the page this row translates."
    translationOf: Int
  }

  input CategoryInput {
    name: String!
    slug: String
    description: String
    parentId: Int
  }

  input TagInput {
    name: String!
    slug: String
  }

  type Query {
    me: User
    posts(
      status: String
      authorId: Int
      categoryId: Int
      tagId: Int
      limit: Int
      offset: Int
    ): PostList!
    post(id: Int!): Post
    postBySlug(slug: String!): Post
    pages(status: String, limit: Int, offset: Int, locale: String): PageList!
    page(id: Int!): Page
    pageBySlug(slug: String!): Page
    categories: [Category!]!
    category(id: Int!): Category
    tags: [Tag!]!
    tag(id: Int!): Tag
    media(limit: Int): [Media!]!
    users: [User!]!
  }

  type Mutation {
    login(email: String!, password: String!): AuthPayload!
    login2fa(ticket: String!, code: String!): AuthPayload!
    createPost(input: PostInput!): Post!
    updatePost(id: Int!, input: PostInput!): Post!
    deletePost(id: Int!): Boolean!
    createPage(input: PageInput!): Page!
    updatePage(id: Int!, input: PageInput!): Page!
    deletePage(id: Int!): Boolean!
    createCategory(input: CategoryInput!): Category!
    updateCategory(id: Int!, input: CategoryInput!): Category!
    deleteCategory(id: Int!): Boolean!
    createTag(input: TagInput!): Tag!
    updateTag(id: Int!, input: TagInput!): Tag!
    deleteTag(id: Int!): Boolean!
  }
`;

// ---- Local read helpers (authed-aware, per-request) ----

type Ctx = { user: SessionUser | null; ip: string | null; ua?: string | null };

// scheduled: JS twin of queries.publishedVisible — a published post or page
// whose publishedAt is still in the future stays a 404 for guests, not just
// hidden from listings.
const notYetVisible = (publishedAt: Date | null) =>
  !!publishedAt && publishedAt.getTime() > Date.now();

// SQL twin for the guest pages listing (posts listing rides the gate inside
// queries.listPosts; pages don't).
const publishedPageVisible = or(isNull(pages.publishedAt), lte(pages.publishedAt, sql`now()`));

async function postById(id: number, authed: boolean) {
  const [row] = await db
    .select({
      post: posts,
      authorName: users.name,
      authorEmail: users.email,
      authorId: users.id,
    })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .where(eq(posts.id, id));
  if (!row) throw new ServiceError("文章不存在", 404);
  if (!authed && (row.post.status !== "published" || notYetVisible(row.post.publishedAt)))
    throw new ServiceError("文章不存在", 404);
  return row;
}

async function postBySlug(slug: string, authed: boolean) {
  const [row] = await db
    .select({
      post: posts,
      authorName: users.name,
      authorEmail: users.email,
      authorId: users.id,
    })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .where(eq(posts.slug, slug));
  if (!row) throw new ServiceError("文章不存在", 404);
  if (!authed && (row.post.status !== "published" || notYetVisible(row.post.publishedAt)))
    throw new ServiceError("文章不存在", 404);
  return row;
}

async function pageById(id: number, authed: boolean) {
  const [row] = await db.select().from(pages).where(eq(pages.id, id));
  if (!row) throw new ServiceError("页面不存在", 404);
  if (!authed && (row.status !== "published" || notYetVisible(row.publishedAt)))
    throw new ServiceError("页面不存在", 404);
  return row;
}

async function pageBySlug(slug: string, authed: boolean) {
  const [row] = await db.select().from(pages).where(eq(pages.slug, slug));
  if (!row) throw new ServiceError("页面不存在", 404);
  if (!authed && (row.status !== "published" || notYetVisible(row.publishedAt)))
    throw new ServiceError("页面不存在", 404);
  return row;
}

/**
 * 0046: the other half of a translation pair. The pointer only lives on the
 * translation row, so the original finds its twin by lookup — the same shape
 * the public loader uses.
 */
async function pagePair(row: { id: number; translationOf: number | null }) {
  const id = row.translationOf ?? (await db
    .select({ id: pages.id })
    .from(pages)
    .where(eq(pages.translationOf, row.id))
    .limit(1))[0]?.id;
  if (!id) return null;
  const [original] = await db.select().from(pages).where(eq(pages.id, id));
  return original ?? null;
}

async function toPost(row: Awaited<ReturnType<typeof postById>>, authed: boolean) {
  const tax = await attachTaxonomies([row.post.id]);
  return {
    ...row.post,
    // The byline is public; the author address is only for signed-in readers
    // (the schema has to allow null here, which it now does).
    author: row.authorId
      ? {
          id: row.authorId,
          name: row.authorName,
          ...(authed ? { email: row.authorEmail } : {}),
        }
      : null,
    categories: tax.categories[row.post.id] ?? [],
    tags: tax.tags[row.post.id] ?? [],
  };
}

async function categoryById(id: number) {
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  return row ?? null;
}

async function tagById(id: number) {
  const [row] = await db.select().from(tags).where(eq(tags.id, id));
  return row ?? null;
}

async function slugOfCategory(id: number): Promise<string | undefined> {
  const row = await categoryById(id);
  return row?.slug;
}

async function slugOfTag(id: number): Promise<string | undefined> {
  const row = await tagById(id);
  return row?.slug;
}

async function listPagesPublic(
  status: string | undefined,
  limit: number | undefined,
  offset: number | undefined,
  authed: boolean,
  locale?: string,
) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const off = offsetNum(offset);
  const loc = locale ? normalizeLocale(locale) : null;
  const where = and(
    status && authed
      ? eq(pages.status, status as any)
      : authed
        ? undefined
        : and(eq(pages.status, "published"), publishedPageVisible),
    // 0045: the content language filter, same vocabulary as posts.
    loc ? eq(pages.locale, loc) : undefined,
  );
  const rows = await db
    .select()
    .from(pages)
    .where(where)
    .orderBy(desc(pages.updatedAt))
    .limit(n)
    .offset(off);
  const [c] = await db
    .select({ n: sql<number>`count(*)` })
    .from(pages)
    .where(where);
  // 0046: the pairs for the whole window in ONE query, not one per row — the
  // list is a public endpoint and a page-per-row lookup would make it N+1.
  // Two halves: the rows themselves (to learn their own pointer) and the
  // rows they point at (the original), plus the rows pointing at them (the
  // translation, when this row IS the original).
  const pairIds = rows.map((r) => r.id);
  const targetIds = rows.map((r) => r.translationOf).filter((v): v is number => v != null);
  const originals = pairIds.length
    ? await db
        .select()
        .from(pages)
        .where(
          or(
            inArray(pages.id, pairIds),
            targetIds.length ? inArray(pages.id, targetIds) : undefined,
            inArray(pages.translationOf, pairIds),
          ),
        )
    : [];
  const byId = new Map(originals.map((o) => [o.id, o]));
  const pairOf = new Map<number, number>();
  for (const o of originals) {
    if (o.translationOf != null) pairOf.set(o.translationOf, o.id);
    if (pairIds.includes(o.id)) pairOf.set(o.id, o.translationOf ?? o.id);
  }
  const items = rows.map((r) => {
    const otherId = pairOf.get(r.id);
    const other = otherId && otherId !== r.id ? byId.get(otherId) : undefined;
    return { ...r, translationOriginal: other ?? null };
  });
  return { items, total: Number(c?.n ?? 0) };
}

// ---- Helpers ----

function requireUser(ctx: Ctx): SessionUser {
  if (!ctx.user) throw new GraphQLError("未认证", { extensions: { code: "UNAUTHENTICATED" } });
  return ctx.user;
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof ServiceError)
      throw new GraphQLError(e.message, {
        extensions: { code: "ERROR", http: { status: e.status } },
      });
    throw e;
  });
}

function publicUser(u: Record<string, unknown>) {
  const { passwordHash, ...rest } = u as { passwordHash?: string };
  return rest;
}

// ---- Resolvers ----

type Resolver = (parent: unknown, args: any, ctx: Ctx) => unknown;

const queryResolvers: Record<string, Resolver> = {
  me: async (_p: unknown, _a: unknown, ctx: Ctx) => {
    if (!ctx.user) return null;
    const [row] = await db.select().from(users).where(eq(users.id, ctx.user.id));
    if (!row) return null;
    return publicUser(row as Record<string, unknown>);
  },
      posts: async (_p, args, ctx) => {
        const [categorySlug, tagSlug] = await Promise.all([
          args.categoryId ? slugOfCategory(args.categoryId) : undefined,
          args.tagId ? slugOfTag(args.tagId) : undefined,
        ]);
        return wrap(async () => {
          const drafts = mayReadDrafts(ctx.user);
          const out = await listPosts({
            status: drafts ? args.status : "published",
            authorId: args.authorId,
            categorySlug,
            tagSlug,
            limit: args.limit ?? 20,
            offset: args.offset ?? 0,
            full: true,
          });
          if (drafts) return out;
          // Anonymous readers get the byline, never the author's address.
          return {
            ...out,
            items: out.items.map((it) => {
              if (!it.author) return it;
              const { email: _mailbox, ...author } = it.author;
              return { ...it, author };
            }),
          };
        });
      },
      post: (_p, { id }, ctx) =>
          wrap(() => {
            const drafts = mayReadDrafts(ctx.user);
            return postById(id, drafts).then((row) => toPost(row, drafts));
          }),
      postBySlug: (_p, { slug }, ctx) =>
        wrap(() => {
            const drafts = mayReadDrafts(ctx.user);
            return postBySlug(slug, drafts).then((row) => toPost(row, drafts));
          }),
      pages: (_p, args, ctx) =>
        wrap(() => listPagesPublic(args.status, args.limit, args.offset, mayReadDrafts(ctx.user), args.locale)),
      page: (_p, { id }, ctx) =>
        wrap(async () => {
          const drafts = mayReadDrafts(ctx.user);
          const row = await pageById(id, drafts);
          return { ...row, translationOriginal: await pagePair(row) };
        }),
      pageBySlug: (_p, { slug }, ctx) =>
        wrap(async () => {
          const drafts = mayReadDrafts(ctx.user);
          const row = await pageBySlug(slug, drafts);
          return { ...row, translationOriginal: await pagePair(row) };
        }),
      categories: () => wrap(() => listCategories()),
      category: (_p, { id }) => wrap(() => categoryById(id)),
      tags: () => wrap(() => listTags()),
      tag: (_p, { id }) => wrap(() => tagById(id)),
      // R261: `listMedia` gates on requireUser ("signed in"), but the media
      // LIBRARY is an editor surface — measured before this fix: a reader
      // (subscriber) listed it through GraphQL, while the REST screen is
      // adminOnly in the sidebar. Same predicate as mayReadDrafts above; the
      // media service itself is left alone because the post editor (which
      // authors DO use) reaches it by another path.
      media: (_p, { limit }, ctx) =>
        wrap(() => {
          if (!mayReadDrafts(ctx.user)) throw new ServiceError("权限不足", 403);
          return listMedia(requireUser(ctx), limit ?? 50).then((r) => r.items);
        }),
      users: (_p, _a, ctx) => wrap(() => adminListUsers(requireUser(ctx))),
};

const mutationResolvers: Record<string, Resolver> = {
  login: async (_p, { email, password }, ctx) => {
        const account = String(email ?? "");
        try {
          await assertLoginAllowed(account, ctx.ip);
        } catch (e) {
          await recordLoginEvent({ eventType: LOGIN_EVENTS.LOCKED, account, ip: ctx.ip });
          if (e instanceof LoginThrottledError)
            throw new GraphQLError(e.message, { extensions: { code: "THROTTLED" } });
          throw e;
        }
        const user = await verifyCredentials(account, password);
        if (!user) {
          await recordLoginEvent({ eventType: LOGIN_EVENTS.FAIL, account, ip: ctx.ip });
          throw new GraphQLError("邮箱或密码错误", { extensions: { code: "UNAUTHENTICATED" } });
        }

        const [, twoFa] = await Promise.all([ensurePluginsLoaded(), getTwoFaState(user.id)]);
        const challenged = twoFa?.enabled
          ? { challenge: { type: "totp" } }
          : await applyAsyncFilters<{
              user: typeof user;
              challenge: { type: string } | null;
            }>(HOOKS.authChallenge, { user, challenge: null });
        if (challenged.challenge) {
          const ticket = await signChallengeTicket(user);
          // Same audit row the REST branches write at this step.
          await recordLoginEvent({ eventType: LOGIN_EVENTS.LOGIN_CHALLENGE, userId: user.id, account, ip: ctx.ip, userAgent: ctx.ua ?? null });
          throw new GraphQLError("需要两步验证", {
            extensions: {
              code: "TWO_FACTOR_REQUIRED",
              challengeType: challenged.challenge.type,
              ticket,
            },
          });
        }
        const token = await signSession(user);
        await Promise.all([
          clearLoginFailures(account),
          recordLoginEvent({
            eventType: LOGIN_EVENTS.SUCCESS,
            userId: user.id,
            account,
            ip: ctx.ip,
            userAgent: ctx.ua ?? null,
          }),
        ]);
        return { token, user };
      },
      login2fa: async (_p, { ticket, code }, ctx) => {
        const user = await verifyChallengeTicket(ticket);
        if (!user) {
          throw new GraphQLError("验证已过期，请重新登录", {
            extensions: { code: "UNAUTHENTICATED" },
          });
        }
        try {
          await assertLoginAllowed(user.name, ctx.ip);
        } catch (e) {
          await recordLoginEvent({ eventType: LOGIN_EVENTS.LOCKED, userId: user.id, account: user.name, ip: ctx.ip });
          if (e instanceof LoginThrottledError)
            throw new GraphQLError(e.message, { extensions: { code: "THROTTLED" } });
          throw e;
        }
        const pluginReady = ensurePluginsLoaded();
        if (!(await Promise.all([pluginReady, verifyTwoFaCode(user.id, code)]))[1]) {
          await recordLoginEvent({ eventType: LOGIN_EVENTS.FAIL, userId: user.id, account: user.name, ip: ctx.ip });
          throw new GraphQLError("动态码或恢复码不正确", {
            extensions: { code: "UNAUTHENTICATED" },
          });
        }
        const verdict = await applyAsyncFilters<{
          user: typeof user;
          code: string;
          ok: boolean;
        }>(HOOKS.authChallengeVerify, { user, code, ok: true });
        if (!verdict.ok) {
          await recordLoginEvent({ eventType: LOGIN_EVENTS.FAIL, userId: user.id, account: user.name, ip: ctx.ip });
          throw new GraphQLError("动态码或恢复码不正确", {
            extensions: { code: "UNAUTHENTICATED" },
          });
        }
        const token = await signSession(user);
        await Promise.all([
          clearLoginFailures(user.name),
          recordLoginEvent({
            eventType: LOGIN_EVENTS.SUCCESS,
            userId: user.id,
            account: user.name,
            ip: ctx.ip,
            userAgent: ctx.ua ?? null,
          }),
        ]);
        return { token, user };
      },
      createPost: (_p, { input }, ctx) =>
        wrap(() => createPost(requireUser(ctx), input)),
      updatePost: (_p, { id, input }, ctx) =>
        wrap(() => updatePost(requireUser(ctx), id, input)),
      deletePost: (_p, { id }, ctx) =>
        wrap(() => deletePost(requireUser(ctx), id).then(() => true)),
      createPage: (_p, { input }, ctx) =>
        wrap(() => createPage(requireUser(ctx), input)),
      updatePage: (_p, { id, input }, ctx) =>
        wrap(() => updatePage(requireUser(ctx), id, input)),
      deletePage: (_p, { id }, ctx) =>
        wrap(() => deletePage(requireUser(ctx), id).then(() => true)),
      createCategory: (_p, { input }, ctx) =>
        wrap(() => createCategory(requireUser(ctx), input)),
      updateCategory: (_p, { id, input }, ctx) =>
        wrap(() => updateCategory(requireUser(ctx), id, input)),
      deleteCategory: (_p, { id }, ctx) =>
        wrap(() => deleteCategory(requireUser(ctx), id).then(() => true)),
      createTag: (_p, { input }, ctx) =>
        wrap(() => createTag(requireUser(ctx), input)),
      updateTag: (_p, { id, input }, ctx) =>
        wrap(() => updateTag(requireUser(ctx), id, input)),
      deleteTag: (_p, { id }, ctx) =>
        wrap(() => deleteTag(requireUser(ctx), id).then(() => true)),
};

export const schema = buildSchema(typeDefs);

function attach(rootType: string, resolvers: Record<string, Resolver>) {
  const t = schema.getType(rootType) as { getFields(): Record<string, { resolve?: Resolver }> } | undefined;
  if (!t) return;
  const fields = t.getFields();
  for (const [name, fn] of Object.entries(resolvers)) {
    if (fields[name]) fields[name].resolve = fn;
  }
}
attach("Query", queryResolvers);
attach("Mutation", mutationResolvers);

/**
 * R260: "logged in" is not "may read unpublished rows".
 *
 * Every resolver below used `!!ctx.user` as the draft predicate, so a plain
 * reader (subscriber — the membership tier) could pull every draft post and
 * page through /api/graphql. Measured before this fix: reader drafts_visible=1,
 * identical to admin. The REST admin loaders had the same defect and were fixed
 * in R258/R259; this is the other door into the same tables, so it uses the
 * same predicate (`adminOnly` = admin || editor) rather than inventing a
 * fourth definition of "staff".
 */
function mayReadDrafts(user: { role?: string } | null | undefined): boolean {
  return !!user && roleAllows(user.role as never, { adminOnly: true });
}

export async function buildContext(req: Request): Promise<Ctx> {
  const user = await getSessionFromRequest(req);
  return { user, ip: clientIp(req), ua: clientUa(req) };
}
