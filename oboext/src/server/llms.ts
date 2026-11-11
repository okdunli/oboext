// /llms.txt — the llmstxt.org convention: a short Markdown index a language
// model can read instead of crawling every page. Static documents only, no
// session state, so it is cacheable like the feeds.
import { listPosts, getSettings } from "./queries.js";
import { listPublishedPages } from "./pages.js";

const MAX_POSTS = 200;
const MAX_PAGES = 100;

export async function buildLlmsTxt(origin: string, locale: "zh-CN" | "en" = "zh-CN"): Promise<string> {
  const settings = await getSettings();
  // The /en tree lists the English articles (the same language-tree rule the
  // feeds and archives follow); the root lists the default locale.
  const [{ items: posts }, { items: pages }] = await Promise.all([
    listPosts({
      status: "published",
      limit: MAX_POSTS,
      pinned: false,
      locale: locale === "en" ? "en" : undefined,
    }),
    listPublishedPages({ limit: MAX_PAGES, locale: locale === "en" ? "en" : undefined }),
  ]);
  // The English document links the /en tree, mirroring localeHref().
  const pref = (u: string) => (locale === "en" ? (u === "/" ? "/en/" : "/en" + u) : u);
  const abs = (u: string) => (u.startsWith("http") ? u : `${origin}${pref(u)}`);
  const line = (title: string, url: string, desc?: string | null) =>
    `- [${String(title).replace(/[[\]]/g, " ").trim()}](${abs(url)})` +
    (desc ? `: ${String(desc).replace(/\s+/g, " ").trim()}` : "");

  const L =
    locale === "en"
      ? { posts: "Posts", pages: "Pages" }
      : { posts: "文章", pages: "页面" };

  const out: string[] = [];
  out.push(`# ${settings.siteTitle || "Oboext"}`, "");
  if (settings.siteDescription) out.push(`> ${settings.siteDescription}`, "");
  out.push(`## ${L.posts}`, "");
  if (posts.length) for (const p of posts) out.push(line(p.title, p.url, p.excerpt));
  out.push("");
  if (pages.length) {
    out.push(`## ${L.pages}`, "");
    for (const p of pages) out.push(line(p.title, p.url, p.excerpt));
    out.push("");
  }
  return out.join("\n");
}
