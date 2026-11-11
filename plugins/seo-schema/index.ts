import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  orgName: string;
  orgLogo: string;
  type: string;
  breadcrumb: boolean;
  website: boolean;
  organization: boolean;
};

type HeadPayload = {
  /** Raw <script>/<meta> strings the layout will render inside <head>. */
  nodes: string[];
  context: {
    kind: "home" | "post" | "page" | "archive" | "taxonomy" | "search";
    siteTitle: string;
    siteUrl: string;
    title?: string;
    description?: string;
    image?: string;
    publishedAt?: string | null;
    updatedAt?: string | null;
    author?: string;
    url?: string;
    breadcrumbs?: { label: string; href: string }[];
  };
};

function jsonLd(data: unknown): string {
  // Escape "</" so a stray sequence in user content cannot close the script tag.
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  return `<script type="application/ld+json">${json}</script>`;
}

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<HeadPayload>(HOOKS.headTags, (payload) => {
      const c = payload.context;
      const orgName = settings.orgName || c.siteTitle;
      // Stable @ids so the nodes form one graph: the WebSite, the Organization
      // and every article reference each other instead of repeating inline
      // copies. Crawlers join same-document nodes by @id; the inline name/logo
      // on the article publisher stays so the node is self-sufficient too.
      const orgId = `${c.siteUrl}/#organization`;
      const siteId = `${c.siteUrl}/#website`;
      const orgNode = {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": orgId,
        name: orgName,
        url: c.siteUrl,
        logo: settings.orgLogo ? { "@type": "ImageObject", url: settings.orgLogo } : undefined,
      };

      // The site-level entity rides on every page so an @id reference always
      // resolves in the same document.
      if (settings.organization !== false) {
        payload.nodes.push(jsonLd(orgNode));
      }

      if (settings.website && c.kind === "home") {
        payload.nodes.push(
          jsonLd({
            "@context": "https://schema.org",
            "@type": "WebSite",
            "@id": siteId,
            name: c.siteTitle,
            url: c.siteUrl,
            publisher: { "@id": orgId },
            potentialAction: {
              "@type": "SearchAction",
              target: `${c.siteUrl}/search?q={search_term_string}`,
              "query-input": "required name=search_term_string",
            },
          }),
        );
      }

      if (c.kind === "post" || c.kind === "page") {
        payload.nodes.push(
          jsonLd({
            "@context": "https://schema.org",
            "@type": c.kind === "post" ? settings.type || "BlogPosting" : "WebPage",
            headline: c.title,
            description: c.description,
            image: c.image ? [c.image] : undefined,
            datePublished: c.publishedAt ?? undefined,
            dateModified: c.updatedAt ?? c.publishedAt ?? undefined,
            author: { "@type": "Person", name: c.author || orgName },
            publisher: {
              "@id": orgId,
              name: orgName,
              logo: settings.orgLogo
                ? { "@type": "ImageObject", url: settings.orgLogo }
                : undefined,
            },
            isPartOf: { "@id": siteId },
            mainEntityOfPage: c.url ? { "@type": "WebPage", "@id": c.url } : undefined,
          }),
        );
      }

      if (settings.breadcrumb && c.breadcrumbs?.length) {
        payload.nodes.push(
          jsonLd({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: c.breadcrumbs.map((b, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: b.label,
              item: `${c.siteUrl}${b.href}`,
            })),
          }),
        );
      }

      return payload;
    });
  },
});
