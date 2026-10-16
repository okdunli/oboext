/**
 * Per-dialect numeric constants.
 *
 * The program implements the layout dialects; a theme only declares which one
 * it uses. The *behaviour* differences between dialects live in loaders.ts as
 * explicit branches, but the plain numbers those branches used to carry
 * (page windows, hero/latest split sizes, related-post counts) are data, not
 * logic — they belong in one table so a new dialect ships without editing
 * four functions, and so the shipped values stay reviewable at a glance.
 *
 * Values below reproduce the pre-R62 inline ternaries exactly; the live smoke
 * matrix (five themes x home/list/search/post) is the equivalence proof.
 */

/** One dialect's numeric tuning. Every field has a program-wide default. */
export interface DialectProfile {
  /** home(): size of the post window sliced off the latest list. */
  homeLimit: number;
  /** home(): posts in the hero block. `0` means the whole window. */
  heroCount: number;
  /** home(): posts in the "latest" block after the hero. `0` means none. */
  latestCount: number;
  /** Category page size. `0` means follow settings.postsPerPage. */
  catPerPage: number;
  /** Search page size. `0` means follow settings.postsPerPage (clamped 1..100). */
  searchPerPage: number;
  /** Post page: related-post block size. */
  relatedN: number;
  /** Post page: taxonomy-based related count (default theme only). */
  taxonomyRelatedN: number;
}

const BASE: DialectProfile = {
  homeLimit: 12,
  heroCount: 4,
  latestCount: 8,
  catPerPage: 12,
  searchPerPage: 20,
  relatedN: 4,
  taxonomyRelatedN: 4,
};

const PROFILES: Record<string, Partial<DialectProfile>> = {
  pseudolinear: {
    homeLimit: 30,
    heroCount: 0,
    latestCount: 0,
    catPerPage: 30,
    searchPerPage: 30,
    relatedN: 5,
  },
  codeman: {
    catPerPage: 30,
    searchPerPage: 30,
    relatedN: 5,
  },
  skyscraper: {
    catPerPage: 0,
  },
  bluemix: {
    searchPerPage: 0,
  },
};

/** Dialects the program ships with; anything else falls back to BASE. */
export const KNOWN_DIALECTS = Object.keys(PROFILES);

/**
 * The numeric profile for a layout dialect. Pure map lookup — no cache, no
 * filesystem. Unknown dialects (including a brand-new theme's dialect) get
 * the BASE defaults, so a new theme works before any per-dialect tuning.
 */
export function dialectProfile(layout: string): DialectProfile {
  const override = PROFILES[layout];
  return override ? { ...BASE, ...override } : BASE;
}
