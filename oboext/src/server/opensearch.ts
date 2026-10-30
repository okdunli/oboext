// OpenSearch 1.1 discovery descriptor.
//
// Browsers read this to offer the site as a search engine ("Add Bug工坊 to
// your browser's search"). It is a machine document like robots.txt and the
// sitemap: locale-independent, cacheable for minutes, and built from the same
// site settings every other head tag already uses.
import { getSettings } from "./queries.js";

/** XML text escape — attribute-safe for the descriptor's few fields. */
function esc(raw: unknown): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildOpenSearchDescriptor(opts: {
  siteTitle: string;
  siteDescription: string;
  origin: string;
}): string {
  const title = opts.siteTitle || "Oboext";
  // Strip once, here: a caller that passes a trailing slash must not produce
  // `https://site//search` in the template.
  const origin = opts.origin.replace(/\/+$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${esc(title.slice(0, 16))}</ShortName>
  <Description>${esc(opts.siteDescription || title)}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="text/html" method="get" template="${esc(origin)}/search?q={searchTerms}"/>
  <Url type="application/json" method="get" template="${esc(origin)}/api/search-suggest?format=opensearch&amp;q={searchTerms}"/>
</OpenSearchDescription>
`;
}

/** The descriptor for this request's origin. */
export async function openSearchDocument(origin: string): Promise<string> {
  const settings = await getSettings();
  return buildOpenSearchDescriptor({
    siteTitle: String(settings.siteTitle ?? ""),
    siteDescription: String(settings.siteDescription ?? ""),
    origin,
  });
}

export const OPENSEARCH_CONTENT_TYPE = "application/opensearchdescription+xml; charset=utf-8";
