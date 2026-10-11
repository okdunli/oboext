import Link from "next/link";
import { Sparkles } from "lucide-react";
import { listPosts } from "@/lib/services/posts";
import { getSettings } from "@/lib/services/settings";
import PostCard from "@/components/shared/PostCard";
import Sidebar from "@/components/shared/Sidebar";

export const dynamic = "force-dynamic";

/**
 * oboext default homepage — featured post + grid + sidebar.
 */
export default async function oboextHomePage() {
  const [{ items }, settings] = await Promise.all([
    listPosts({ status: "published", limit: 12 }),
    getSettings(),
  ]);

  const [featured, ...rest] = items;

  return (
    <div className="space-y-10">
      <section className="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-gradient-to-br from-[var(--surface)] to-[var(--bg)] px-8 py-12 text-center">
        <Sparkles size={28} className="mx-auto mb-4 text-[var(--accent)]" />
        <h1 className="text-4xl font-bold tracking-tight text-zinc-100">{settings.siteTitle}</h1>
        {settings.tagline && <p className="mt-3 text-base text-zinc-400">{settings.tagline}</p>}
        {settings.siteDescription && (
          <p className="mx-auto mt-3 max-w-2xl text-sm text-zinc-500">{settings.siteDescription}</p>
        )}
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        <div>
          {items.length === 0 ? (
            <p className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-zinc-400">
              还没有已发布的文章。
            </p>
          ) : (
            <div className="space-y-6">
              {featured && (
                <article className="group overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)]">
                  {featured.featuredImage && (
                    <Link href={`/blog/${featured.slug}`} className="block aspect-[21/9] overflow-hidden">
                      <img
                        src={featured.featuredImage}
                        alt={featured.title}
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                        loading="lazy"
                      />
                    </Link>
                  )}
                  <div className="p-6">
                    <div className="mb-2 flex flex-wrap gap-2 text-xs">
                      {featured.categories.slice(0, 3).map((c) => (
                        <Link
                          key={c.id}
                          href={`/blog/category/${c.slug}`}
                          className="rounded-full bg-[var(--accent)]/15 px-2.5 py-0.5 text-[var(--accent)]"
                        >
                          {c.name}
                        </Link>
                      ))}
                    </div>
                    <h2 className="text-2xl font-bold leading-snug text-zinc-100">
                      <Link href={`/blog/${featured.slug}`} className="transition group-hover:text-[var(--accent)]">
                        {featured.title}
                      </Link>
                    </h2>
                    <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)]">
                      <Sparkles size={13} />
                      推荐阅读
                    </span>
                    {featured.excerpt && (
                      <p className="mt-3 line-clamp-3 text-sm text-zinc-400">{featured.excerpt}</p>
                    )}
                  </div>
                </article>
              )}

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                {rest.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
            </div>
          )}
        </div>
        <Sidebar />
      </div>
    </div>
  );
}
