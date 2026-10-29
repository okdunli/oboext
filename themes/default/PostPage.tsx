import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, User, Calendar, Eye, MessageCircle } from "lucide-react";
import { getPostBySlug, incrementViews } from "@/lib/services/posts";
import { getSettings } from "@/lib/services/settings";
import { formatDate } from "@/lib/utils";
import {
  renderContent,
  renderPlainText,
  buildPostMeta,
} from "@/lib/services/render";

import Comments from "@/components/shared/CommentsLazy";
import Sidebar from "@/components/shared/Sidebar";
import Breadcrumb from "@/components/shared/Breadcrumb";
import PostToc from "@/components/shared/PostTocLazy";
import ShareButtons from "@/components/shared/ShareButtonsLazy";
import RelatedPosts from "@/components/shared/RelatedPosts";
import WidgetArea from "@/components/shared/WidgetArea";
import { THEME_SLUG } from "@/themes/default";

export const dynamic = "force-dynamic";

/**
 * Oboext default blog post page.
 */
export default async function oboextPostPage({ params }: { params: { slug: string } }) {
  let post;
  try {
    post = await getPostBySlug(params.slug);
  } catch {
    notFound();
  }

  try {
    await incrementViews(post.id);
  } catch {
    /* noop */
  }

  const settings = await getSettings();
  const canonical = `${process.env.NEXT_PUBLIC_SITE_URL || ""}/blog/${post.slug}`;

  // Run the content through the plugin-aware pipeline: shortcodes expand,
  // `content.html` filters apply, and enabled plugins are loaded first.
  const html = await renderContent(post.content, {
    kind: "post",
    postId: post.id,
    slug: post.slug,
    siteTitle: settings.siteTitle,
  });
  const plain = renderPlainText(post.content);
  // Plugins append rows (e.g. reading-time) to the post meta line.
  const meta = await buildPostMeta(post, plain);
  // Plugin <head> nodes (e.g. seo-schema JSON-LD) are emitted once by the
  // public catch-all page, not per theme.

  return (
    <>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        <article>
          <header className="mb-6">
            <Link
              href="/"
              className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-[var(--accent)]"
            >
              <ArrowLeft size={14} />
              返回首页
            </Link>
            <Breadcrumb
              items={[
                { label: "首页", href: "/" },
                { label: "文章", href: "/blog" },
                ...post.categories.slice(0, 1).map((c) => ({
                  label: c.name,
                  href: `/blog/category/${c.slug}`,
                })),
                { label: post.title },
              ]}
            />
            <div className="mb-3 mt-3 flex flex-wrap gap-2 text-xs">
              {post.categories.map((c) => (
                <Link
                  key={c.id}
                  href={`/blog/category/${c.slug}`}
                  className="rounded-full bg-[var(--accent)]/15 px-2.5 py-0.5 text-[var(--accent)]"
                >
                  {c.name}
                </Link>
              ))}
            </div>
            <h1 className="text-3xl font-bold leading-tight text-zinc-100">{post.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-zinc-500">
              <span className="inline-flex items-center gap-1">
                <User size={14} />
                {post.author?.name ?? "未知作者"}
              </span>
              <span className="inline-flex items-center gap-1">
                <Calendar size={14} />
                {formatDate(post.publishedAt)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Eye size={14} />
                {post.views} 阅读
              </span>
              {post.commentsCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <MessageCircle size={14} />
                  {post.commentsCount} 评论
                </span>
              )}
            </div>
            {meta.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-zinc-500">
                {meta.map((m) => (
                  <span key={m.label}>{m.label}：{m.value}</span>
                ))}
              </div>
            )}
          </header>

          {post.featuredImage && (
            <img
              src={post.featuredImage}
              alt={post.title}
              className="mb-6 w-full rounded-2xl border border-[var(--border)] object-cover"
            />
          )}

          <div className="prose-cms" dangerouslySetInnerHTML={{ __html: html }} />

          {post.tags.length > 0 && (
            <div className="mt-8 flex flex-wrap gap-2 border-t border-[var(--border)] pt-6">
              {post.tags.map((t) => (
                <Link
                  key={t.id}
                  href={`/blog/tag/${t.slug}`}
                  className="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-zinc-300 hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  #{t.name}
                </Link>
              ))}
            </div>
          )}

          <ShareButtons title={post.title} url={canonical} />

          <RelatedPosts postId={post.id} />

          <WidgetArea themeSlug={THEME_SLUG} area="post-bottom" />

          <Comments
            postId={post.id}
            postType="post"
            open={post.commentStatus === "open"}
            requireNameEmail={settings.requireNameEmail}
          />
        </article>
        <div className="space-y-6">
          <PostToc />
          <Sidebar />
          <WidgetArea themeSlug={THEME_SLUG} area="sidebar" />
        </div>
      </div>
    </>
  );
}
