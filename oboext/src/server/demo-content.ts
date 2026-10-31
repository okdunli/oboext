// First-run demo content: a new install used to open on an empty blog shell -
// the theme looked broken, the menus had nothing to point at, and a first-time
// operator had no example of the block editor's output.
//
// Only an empty site may seed it (a second click must not duplicate anything),
// and it goes through the SAME services the admin UI uses, so the rows carry
// every invariant a hand-written post does (slug uniqueness, plain-text body,
// taxonomy joins, revisions).
import { rawQuery, ensureMigrations } from "./db.js";
import { can, createCategory, createPost, createTag, requireCap, ServiceError } from "./admin.js";
import { createPage } from "./pages.js";
import { ensureDefaultMenus, listMenus, updateMenu } from "./menus.js";
import { blogIndexUrlFor, getPermalinkConfig, pageIndexUrlFor, pageUrlFor } from "./links.js";
import type { SessionUser } from "./auth.js";
import type { Block } from "./schema.js";

export type DemoSeedResult = {
  posts: number;
  pages: number;
  categories: number;
  tags: number;
};

type PostInput = Parameters<typeof createPost>[1];

const PARA = (id: string, text: string): Block => ({ id, type: "paragraph", text });
const H2 = (id: string, text: string): Block => ({ id, type: "heading", level: 2, text });

/** Refuse on any existing content: a demo seed must never mix into real rows. */
async function assertEmpty(): Promise<void> {
  const [row] = await rawQuery<{ n: number }>(
    `select (select count(*) from posts) + (select count(*) from pages) as n`,
  );
  if (Number(row?.n ?? 0) > 0) {
    throw new ServiceError("站点已有内容，示例内容只能在空站导入", 409);
  }
}

// A fresh install also had an empty nav: the default menus carry one "Home"
// item, so the seeded pages existed but nothing linked to them. Point the
// default menus at the real routes - only while they still hold nothing but
// that seeded item, so a menu the operator already edited is never touched.
async function seedMenuLinks(user: SessionUser): Promise<void> {
  // Cosmetic: an editor without settings:manage still gets the content.
  if (!can(user.role, "settings:manage")) return;
  await ensureDefaultMenus();
  const cfg = await getPermalinkConfig();
  const pageIndex = pageIndexUrlFor(cfg);
  const extra = [
    { label: "@sidebar.all_posts", url: blogIndexUrlFor(cfg) },
    ...(pageIndex ? [{ label: "@sidebar.all_pages", url: pageIndex }] : []),
    // Built through the real link builders: with the default pageBase the
    // seeded pages live at /pages/about, not at the root.
    { label: "关于本站", url: pageUrlFor(cfg, { slug: "about" }) },
    { label: "联系", url: pageUrlFor(cfg, { slug: "contact" }) },
  ].map((it) => ({ ...it, type: "custom", target: "_self", icon: null }));
  for (const menu of await listMenus()) {
    if (menu.items.length !== 1 || menu.items[0]!.label !== "@crumb.home") continue;
    const home = menu.items[0]!;
    await updateMenu(user, menu.id, {
      items: [
        { id: home.id, label: home.label, url: home.url, type: home.type, target: home.target, icon: home.icon },
        ...extra,
      ],
    });
  }
}

export async function seedDemoContent(user: SessionUser | null): Promise<DemoSeedResult> {
  requireCap(user, "content:create");
  await ensureMigrations();
  await assertEmpty();
  const author = user as SessionUser;

  const guides = await createCategory(author, {
    name: "指南",
    slug: "guides",
    description: "入门与使用说明",
  });
  const notes = await createCategory(author, { name: "随笔", slug: "notes" });
  const welcome = await createTag(author, { name: "欢迎", slug: "welcome" });
  const tutorial = await createTag(author, { name: "教程", slug: "tutorial" });

  const postDefs: PostInput[] = [
    {
      title: "欢迎来到你的新站点",
      slug: "hello-world",
      excerpt: "示例文章：它展示标题、正文、分类与标签在一起的样子。",
      status: "published",
      content: [
        PARA("d1", "这篇文章是自动生成的示例，用来让首页、文章页和分类页在第一次打开时就有内容可看。"),
        H2("d2", "从这里开始"),
        PARA("d3", "你可以在后台删除它，或者直接在上面改写成自己的第一篇文章。编辑器保存时会把正文投影成纯文本，所以搜索能直接命中正文里的词。"),
        PARA("d4", "分类「指南」与标签「欢迎」「教程」同样是示例，后台里可以随意改名或删除。"),
      ],
      categoryIds: [guides.id],
      tagIds: [welcome.id, tutorial.id],
    },
    {
      title: "写作与发布：一篇示例随笔",
      slug: "a-sample-note",
      excerpt: "示例随笔：说明草稿、定时发布与修改记录在哪里。",
      status: "published",
      content: [
        PARA("d5", "这是一篇示例随笔，归在「随笔」分类里。"),
        H2("d6", "草稿与定时"),
        PARA("d7", "把状态设成草稿，或把发布时间设到未来，内容就不会出现在公开页面；作者与管理员仍可通过预览链接查看。"),
        PARA("d8", "每次保存都会留下一条修改记录，恢复旧版本不会触发新的通知。"),
      ],
      categoryIds: [notes.id],
      tagIds: [welcome.id],
    },
    {
      title: "把站点长成你自己的样子",
      slug: "make-it-yours",
      excerpt: "主题、菜单、订阅与备份：示例内容之外的下一步。",
      status: "published",
      content: [
        PARA("d9", "示例内容只是起点。接下来更值得做的是：换主题、调整菜单、配置订阅邮件、安排第一次备份。"),
        H2("d10", "三件事"),
        PARA("d11", "主题决定排版与配色；菜单决定读者能否找到你的页面；订阅邮件决定新文章发出后会不会有人回来。"),
        PARA("d12", "备份包含数据库与上传文件，恢复时按同一份包倒回去即可。"),
      ],
      categoryIds: [guides.id],
      tagIds: [tutorial.id],
    },
  ];
  for (const def of postDefs) await createPost(author, def);

  await createPage(author, {
    title: "关于本站",
    slug: "about",
    status: "published",
    content: [
      PARA("p1", "这是示例页面。页面的正文检索与文章一致，读者可以在搜索框里按标题或正文找到它。"),
    ],
  });
  await createPage(author, {
    title: "联系",
    slug: "contact",
    status: "published",
    content: [PARA("p2", "示例联系页。写下你的邮箱或社交账号，读者就能找到你。")],
  });

  await seedMenuLinks(author);

  return { posts: postDefs.length, pages: 2, categories: 2, tags: 2 };
}
