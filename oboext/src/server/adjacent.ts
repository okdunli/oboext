// Adjacent-post navigation (上一篇 / 下一篇).
//
// Pure core with zero imports so it unit-tests without a database: the SQL
// side (queries.getAdjacentPosts) only fetches two LIMIT 1 rows tagged with a
// direction; every decision that can be made in JS is made here.
//
// Ordering contract: a post's key is `coalesce(published_at, created_at)` —
// the same expression the visibility gate and the SQL use, so a post whose
// publishedAt is null still has a total position. `newer` is the first
// published post after the key (下一篇), `older` the last one before it
// (上一篇).

export interface AdjacentRow {
  /** 'newer' = the post after the current one; 'older' = the post before it. */
  dir?: unknown;
  id?: unknown;
  title?: unknown;
  slug?: unknown;
  publishedAt?: unknown;
  createdAt?: unknown;
}

export interface AdjacentPost {
  id: number;
  title: string;
  url: string;
  publishedAt: Date | null;
}

export interface AdjacentPair {
  /** The next post in chronological order (下一篇). */
  newer: AdjacentPost | null;
  /** The previous post in chronological order (上一篇). */
  older: AdjacentPost | null;
}

/** The ordering key of the current post: publishedAt, else createdAt. */
export function adjacentKeyOf(post: {
  publishedAt?: unknown;
  createdAt?: unknown;
}): Date {
  const raw = post.publishedAt ?? post.createdAt;
  if (raw == null || raw === "") return new Date();
  const d = new Date(raw as string | number | Date);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Fold the two tagged rows into a pair. Never throws on malformed input: a
 * row without a numeric id is skipped, a missing direction is ignored, and
 * the first row per direction wins (the SQL returns at most one each).
 */
export function buildAdjacent(
  rows: AdjacentRow[],
  urlFor: (row: AdjacentRow) => string,
): AdjacentPair {
  const pair: AdjacentPair = { newer: null, older: null };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const id = typeof r.id === "number" ? r.id : Number(r.id);
    if (!Number.isFinite(id)) continue;
    const post: AdjacentPost = {
      id,
      title: String(r.title ?? ""),
      url: urlFor(r),
      publishedAt: toDate(r.publishedAt),
    };
    if (r.dir === "newer") {
      if (!pair.newer) pair.newer = post;
    } else if (r.dir === "older") {
      if (!pair.older) pair.older = post;
    }
  }
  return pair;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** YYYY-MM-DD in UTC so the rendered card never shifts a day by timezone. */
export function ymd(v: Date | null): string {
  if (!v) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`;
}

/**
 * The visible 上一篇/下一篇 card. Theme-neutral: inline styles on CSS
 * variables only (--border / --muted / --text / --accent), the same contract
 * the tags row uses, so every theme skins it for free. Empty string when the
 * post has no neighbor in a direction — the slot simply collapses.
 */
export function adjacentHtml(pair: AdjacentPair): string {
  const cell = (post: AdjacentPost, side: "older" | "newer"): string => {
    const isOlder = side === "older";
    const label = isOlder ? "上一篇" : "下一篇";
    const arrow = isOlder ? "&lsaquo;" : "&rsaquo;";
    const date = ymd(post.publishedAt);
    return (
      `<a href="${esc(post.url)}" rel="${isOlder ? "prev" : "next"}" ` +
      `style="display:block;padding:14px 16px;border:1px solid var(--border);border-radius:10px;` +
      `text-decoration:none;color:var(--text);${isOlder ? "" : "text-align:right"}" ` +
      `data-adjacent="${side}">` +
      `<span style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px">${arrow} ${label}${date ? ` · ${date}` : ""}</span>` +
      `<span style="display:block;font-size:14px;font-weight:600;line-height:1.5">${esc(post.title)}</span>` +
      `</a>`
    );
  };
  const cells: string[] = [];
  if (pair.older) cells.push(cell(pair.older, "older"));
  if (pair.newer) cells.push(cell(pair.newer, "newer"));
  if (!cells.length) return "";
  const cols = cells.length === 2 ? "grid-template-columns:1fr 1fr" : "grid-template-columns:1fr";
  return (
    `<nav aria-label="文章导航" data-adjacent-nav ` +
    `style="margin-top:32px;display:grid;${cols};gap:12px;border-top:1px solid var(--border);padding-top:24px">` +
    cells.join("") +
    `</nav>`
  );
}

/**
 * rel=prev / rel=next for the document head. `prev` is the chronologically
 * earlier post (上一篇), `next` the later one (下一篇) — the reading order a
 * visitor paging through the archive follows. Only present neighbors are
 * emitted; an empty string keeps the head untouched for edge posts.
 */
export function adjacentRelLinks(pair: AdjacentPair): string {
  let out = "";
  if (pair.older) out += `<link rel="prev" href="${esc(pair.older.url)}">`;
  if (pair.newer) out += `<link rel="next" href="${esc(pair.newer.url)}">`;
  return out;
}
