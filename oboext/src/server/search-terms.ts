// Search-term telemetry for the admin hot-terms screen (/admin/search-terms).
//
// One row per (term, locale), bumped by an upsert. The contract that matters:
// recordSearchTerm is called from the PUBLIC search loader on every hit, so it
// must never delay or fail the search response — the write is fire-and-forget
// (void (async () => ...)(), the comment-mail-notify plugin's shape at
// plugins/comment-mail-notify/index.ts:44-51) and every failure degrades to a
// warn. A lost increment costs nothing; a slow search costs a visitor.
import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { searchTerms } from "./schema.js";
import { createLogger } from "./logger.js";

const log = createLogger("search-terms");

/** Stored terms are bounded so a paste bomb cannot bloat the table. */
export const MAX_TERM = 64;
/** Below two characters a term carries no signal and matches everything. */
const MIN_TERM = 2;

/**
 * trim -> lowercase -> hard cap at 64 chars. The normalization is what makes
 * the upsert's counter meaningful: " LoRa " and "lora" must land on one row.
 */
export function normalizeSearchTerm(q: string): string {
  return String(q ?? "").trim().toLowerCase().slice(0, MAX_TERM);
}

/**
 * Count one search (zero-result terms included — they are the content gaps
 * the screen exists for). Returns void by design: there is nothing for the
 * caller to await, and nothing that can throw synchronously.
 */
export function recordSearchTerm(q: string, locale = "zh-CN"): void {
  const term = normalizeSearchTerm(q);
  if (term.length < MIN_TERM) return;
  const loc = String(locale || "zh-CN").slice(0, 32) || "zh-CN";
  void (async () => {
    try {
      await db
        .insert(searchTerms)
        .values({ term, locale: loc, hits: 1 })
        .onConflictDoUpdate({
          target: [searchTerms.term, searchTerms.locale],
          set: { hits: sql`search_terms.hits + 1`, lastAt: sql`now()` },
        });
    } catch (e) {
      log.warn("[search-terms] record failed", e);
    }
  })();
}
