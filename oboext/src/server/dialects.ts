/**
 * Per-dialect numeric constants.
 *
 * One BASE profile: the page windows, hero/latest split sizes and related-post
 * counts the loaders read. The program ships a single public theme, so every
 * layout resolves to BASE; unknown layouts get it too, which keeps a new theme
 * working before any per-dialect tuning exists.
 */

/** One dialect's numeric tuning. Every field has a program-wide default. */
export interface DialectProfile {
  /** home(): size of the post window sliced off the latest list. */
  homeLimit: number;
  /** home(): posts in the hero block. `0` means the whole window. */
  heroCount: number;
  /** home(): posts in the "latest" block after the hero. `0` means none. */
  latestCount: number;
  /** Search page size. `0` means follow settings.postsPerPage (clamped 1..100). */
  searchPerPage: number;
  /** Post page: taxonomy-based related count (default theme only). */
  taxonomyRelatedN: number;
}

const BASE: DialectProfile = {
  homeLimit: 12,
  heroCount: 4,
  latestCount: 8,
  searchPerPage: 20,
  taxonomyRelatedN: 4,
};

/**
 * The numeric profile for a layout dialect. Pure lookup — no cache, no
 * filesystem. Every layout gets the BASE defaults.
 */
export function dialectProfile(layout: string): DialectProfile {
  return BASE;
}

/**
 * The blog/author list window: the admin's per-page setting, or 12. The
 * sitemap reads the same function, so its page counts can never disagree with
 * the served windows.
 */
export function blogListSize(postsPerPage?: number | null): number {
  return postsPerPage || 12;
}
