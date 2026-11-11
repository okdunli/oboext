import type { Block } from "./schema.js";

/**
 * The program's ONE block→text rule. It feeds four things that must agree:
 * generated excerpts, the stored search column (bodyPlain), reading time on
 * the public post page, and the full-content RSS/JSON feed. It lived twice
 * (admin.ts and render.ts) and the copies had drifted — an `html` block
 * reached search but vanished from the feed, so an HTML-built post shipped an
 * empty <description>.
 */
export function blocksToPlainText(blocks: Block[] | null | undefined): string {
  return (blocks ?? [])
    .map((b) => {
      switch (b.type) {
        case "heading":
        case "paragraph":
        case "quote":
          return "text" in b ? b.text : "";
        case "image":
          return b.alt || b.caption || "";
        case "code":
          return b.code;
        case "list":
          return b.items.join(" ");
        case "html":
          return b.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join(" ");
}
