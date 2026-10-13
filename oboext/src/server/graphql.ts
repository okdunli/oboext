

import { buildSchema, GraphQLError } from "graphql";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "./db.js";
import { categories, media, pages, posts, tags, users } from "./schema.js";
import {
  getSessionFromRequest,
  signChallengeTicket,
  signSession,
  verifyChallengeTicket,
  verifyCredentials,
  type SessionUser,
} from "./auth.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { HOOKS, applyAsyncFilters } from "./hooks.js";
import { ServiceError } from "./errors.js";
import { attachTaxonomies, listCategories, listPosts, listTags } from "./queries.js";
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

const typeDefs = /* GraphQL */ `
  scalar JSON
  scalar DateTime

  type User {
    id: Int!
    email: String!
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
    pages(status: String, limit: Int, offset: Int): PageList!
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

type Ctx = { user: SessionUser | null };

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
  if (!authed && row.post.status !== "published")
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
  if (!authed && row.post.status !== "published")
    throw new ServiceError("文章不存在", 404);
  return row;
}

async function pageById(id: number, authed: boolean) {
  const [row] = await db.select().from(pages).where(eq(pages.id, id));
  if (!row) throw new ServiceError("页面不存在", 404);
  if (!authed && row.status !== "published")
    throw new ServiceError("页面不存在", 404);
  return row;
}

async function pageBySlug(slug: string, authed: boolean) {
  const [row] = await db.select().from(pages).where(eq(pages.slug, slug));
  if (!row) throw new ServiceError("页面不存在", 404);
  if (!authed && row.status !== "published")
    throw new ServiceError("页面不存在", 404);
  return row;
}

async function toPost(row: Awaited<ReturnType<typeof postById>>) {
  const tax = await attachTaxonomies([row.post.id]);
  return {
    ...row.post,
    author: row.authorId
      ? { id: row.authorId, name: row.authorName, email: row.authorEmail }
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
) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const off = Math.max(0, Number(offset) || 0);
  const where =
    status && authed
      ? eq(pages.status, status as any)
      : authed
        ? undefined
        : eq(pages.status, "published");
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
  return { items: rows, total: Number(c?.n ?? 0) };
}

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
        return wrap(() =>
          listPosts({
            status: ctx.user ? args.status : "published",
            authorId: args.authorId,
            categorySlug,
            tagSlug,
            limit: args.limit ?? 20,
            offset: args.offset ?? 0,
          }),
        );
      },
      post: (_p, { id }, ctx) => wrap(() => postById(id, !!ctx.user).then(toPost)),
      postBySlug: (_p, { slug }, ctx) =>
        wrap(() => postBySlug(slug, !!ctx.user).then(toPost)),
      pages: (_p, args, ctx) =>
        wrap(() => listPagesPublic(args.status, args.limit, args.offset, !!ctx.user)),
      page: (_p, { id }, ctx) => wrap(() => pageById(id, !!ctx.user)),
      pageBySlug: (_p, { slug }, ctx) => wrap(() => pageBySlug(slug, !!ctx.user)),
      categories: () => wrap(() => listCategories()),
      category: (_p, { id }) => wrap(() => categoryById(id)),
      tags: () => wrap(() => listTags()),
      tag: (_p, { id }) => wrap(() => tagById(id)),
      media: (_p, { limit }, ctx) =>
        wrap(() => listMedia(requireUser(ctx), limit ?? 50).then((r) => r.items)),
      users: (_p, _a, ctx) => wrap(() => adminListUsers(requireUser(ctx))),
};

const mutationResolvers: Record<string, Resolver> = {
  login: async (_p, { email, password }) => {
        const user = await verifyCredentials(email, password);
        if (!user) throw new GraphQLError("邮箱或密码错误", { extensions: { code: "UNAUTHENTICATED" } });

        await ensurePluginsLoaded();
        const challenged = await applyAsyncFilters<{
          user: typeof user;
          challenge: { type: string } | null;
        }>(HOOKS.authChallenge, { user, challenge: null });
        if (challenged.challenge) {
          const ticket = await signChallengeTicket(user);
          throw new GraphQLError("需要两步验证", {
            extensions: {
              code: "TWO_FACTOR_REQUIRED",
              challengeType: challenged.challenge.type,
              ticket,
            },
          });
        }
        const token = await signSession(user);
        return { token, user };
      },
      login2fa: async (_p, { ticket, code }) => {
        const user = await verifyChallengeTicket(ticket);
        if (!user) {
          throw new GraphQLError("验证已过期，请重新登录", {
            extensions: { code: "UNAUTHENTICATED" },
          });
        }
        await ensurePluginsLoaded();
        const verdict = await applyAsyncFilters<{
          user: typeof user;
          code: string;
          ok: boolean;
        }>(HOOKS.authChallengeVerify, { user, code, ok: false });
        if (!verdict.ok) {
          throw new GraphQLError("动态码或恢复码不正确", {
            extensions: { code: "UNAUTHENTICATED" },
          });
        }
        const token = await signSession(user);
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

export async function buildContext(req: Request): Promise<Ctx> {
  const user = await getSessionFromRequest(req);
  return { user };
}
