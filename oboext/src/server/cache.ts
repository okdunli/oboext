/**
 * In-process SWR memo for read queries — the data-layer half of oboext's
 * caching story. The route layer already memoizes rendered HTML (render
 * cache=N); this cache sits one level down and keeps repeated requests (and
 * repeated widget resolutions on the same page) from re-hitting the database
 * for data that changes at most every few seconds.
 *
 * Semantics are stale-while-revalidate, not hard TTL: inside `ttl` the cached
 * value returns as-is; past `ttl` (up to SWR_WINDOW * ttl) the STALE value
 * still returns instantly while one background refresh re-runs the query —
 * so an expiring entry no longer turns into a latency spike for whoever
 * asks next. Past the stale window (or cold) the query is awaited for real.
 * Writes call invalidate* to drop affected entries early; a drop forces the
 * next read to await fresh data (correctness where it matters).
 *
 * The store is per-process (module scope), so every worker gets its own copy;
 * a short TTL (default 30s) bounds staleness without any cross-process
 * coordination. Background refreshes are deduplicated per key via the
 * in-flight promise stored on the entry.
 */
const store = new Map<
  string,
  { at: number; value: unknown; refreshing?: Promise<unknown> }
>();

export const SIDEBAR_TTL = 30_000;

/** How long a stale entry may keep serving while a background refresh runs. */
const SWR_WINDOW = 5;

async function memo<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit) {
    if (now - hit.at < ttl) return hit.value as T;
    if (now - hit.at < SWR_WINDOW * ttl) {
      if (!hit.refreshing) {
        hit.refreshing = fn()
          .then((value) => {
            store.set(key, { at: Date.now(), value });
            return value;
          })
          .catch(() => {
            const cur = store.get(key);
            if (cur && cur.refreshing) cur.refreshing = undefined;
          });
      }
      return hit.value as T;
    }
  }
  const value = await fn();
  store.set(key, { at: now, value });
  return value;
}

/** Drop every cached entry whose key starts with `prefix`. */
export function invalidatePrefix(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

/** Drop the entire cache (used on bulk content changes / cache warm resets). */
export function invalidateAll(): void {
  store.clear();
}

/**
 * Drop every entry a content write can stale: taxonomies, counts, the archive
 * timeline, popular/recent lists, generic post listings and widget data. Called
 * from post/tag/category/comment write paths so the sidebar refreshes
 * immediately instead of waiting out the TTL.
 */
export function invalidateContentCaches(): void {
  invalidatePrefix("tax:");
  invalidatePrefix("counts");
  invalidatePrefix("archive");
  invalidatePrefix("popular");
  invalidatePrefix("lp:");
  invalidatePrefix("widget:");
}

/**
 * Memoize `fn` under `key` for `ttl` ms (SWR: stale reads never block). Returns
 * the cached value by reference (the query functions build fresh objects, so
 * callers must not mutate them — the same contract `getSettings` already
 * relies on).
 */
export function memoQuery<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  return memo(key, ttl, fn);
}
