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
 *
 * COLD misses are deduplicated too, via the separate `inflight` map below.
 * The SWR branch has always deduped its background refresh, but the cold path
 * (`await fn()`) did not: on a cold process every concurrent reader missed
 * simultaneously and issued its own query. Measured on /archives against a
 * remote Neon: `site_settings` was selected 6 times in one render, `themes` 7.
 * The dedup map is what makes "N concurrent readers, one query" true on the
 * first request as well as on refreshes.
 */
const store = new Map<
  string,
  { at: number; value: unknown; refreshing?: Promise<unknown> }
>();

/**
 * In-flight query promises, keyed the same as `store`.
 *
 * Separate from `store` on purpose: an entry here means "a query is running
 * right now", which is a different fact from "a value is cached". Putting the
 * promise in `store` instead would make a concurrent reader see the pending
 * promise as a cached value and hand out a Promise where a T is expected.
 *
 * Entries are removed in a `finally`, so a rejected query does not poison the
 * key — the next reader retries instead of awaiting a dead promise forever.
 */
const inflight = new Map<string, Promise<unknown>>();

export const SIDEBAR_TTL = 30_000;

/** How long a stale entry may keep serving while a background refresh runs. */
const SWR_WINDOW = 5;

/**
 * Hard ceiling on entries, so a key space that includes request input cannot
 * grow the store without bound.
 *
 * Most keys here are a fixed set (`settings`, `tax:*`, `counts`, `lp:*`), but
 * `lp:` is keyed by list parameters — archive month, category, tag, page
 * offset, search term — so a crawler walking permutations, or a client
 * looping over offsets, mints a new entry each time. Nothing ever removed
 * them: `invalidatePrefix` only runs on writes, and an entry nobody reads
 * again is never revisited, so it sat in the Map for the life of the process.
 * On a long-lived Node server that is a slow leak; on Vercel it is bounded by
 * the instance lifetime and therefore invisible, which is exactly why it is
 * easy to ship.
 *
 * The bound is generous on purpose. Eviction is Map insertion order, so the
 * entries that go are the oldest-written — and in this workload the hot keys
 * (`settings`, the active theme) are rewritten on every request, so they are
 * always recent and never evicted. The cold keys that accumulate are the ones
 * no longer being asked for.
 *
 * 512 entries at the default TTL is far more than a live site reaches; a site
 * large enough to approach it is one where re-running a query is cheaper than
 * keeping rows nobody reads.
 */
const MAX_ENTRIES = 512;

/**
 * Insert, or refresh an existing entry, then enforce the ceiling.
 *
 * Called on every WRITE and on every cache HIT. The hit case is the load-bearing
 * one: without it the store's insertion order is the order in which each key
 * was last *written*, so a key that is read constantly but written once (a
 * long-TTL entry, or one whose TTL has not expired) never moves and gets
 * evicted as "oldest" while a hundred one-shot keys occupy the store. The
 * tests in tools/cache-evict-check.mts caught exactly that: the flood passed
 * the bound check, and the hot key still went.
 *
 * Map preserves insertion order and delete+set appends, so this is an LRU by
 * recency-of-use with no extra bookkeeping. The cost is one Map delete and one
 * Map set per hit, against a store whose ceiling is 512 and whose entries are
 * objects — cheap next to the database round trip the hit just avoided.
 */
function put(key: string, entry: { at: number; value: unknown }): void {
  const prev = store.get(key);
  const next = prev && prev.refreshing ? { ...entry, refreshing: prev.refreshing } : entry;
  store.delete(key);
  store.set(key, next);
  if (store.size > MAX_ENTRIES) {
    const drop = store.size - MAX_ENTRIES;
    let i = 0;
    for (const k of store.keys()) {
      if (i++ >= drop) break;
      store.delete(k);
    }
  }
}

/**
 * Move a key to the most-recent position without rewriting its entry.
 *
 * A hit must refresh recency but must NOT reset `at` — that timestamp is the
 * TTL clock, and moving it forward on every read would make an entry immortal
 * under continuous polling and turn the TTL into a no-op.
 */
function touch(key: string): void {
  const hit = store.get(key);
  if (!hit) return;
  store.delete(key);
  store.set(key, hit);
}

async function memo<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit) {
    if (now - hit.at < ttl) {
      touch(key);
      return hit.value as T;
    }
    if (now - hit.at < SWR_WINDOW * ttl) {
      if (!hit.refreshing) {
        hit.refreshing = fn()
          .then((value) => {
            put(key, { at: Date.now(), value });
            return value;
          })
          .catch((e) => {
            console.warn(
              `[cache] background refresh failed for ${key}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
            const cur = store.get(key);
            if (cur && cur.refreshing) cur.refreshing = undefined;
          });
      }
      return hit.value as T;
    }
  }
  return runOnce(key, async () => {
    const value = await fn();
    put(key, { at: Date.now(), value });
    return value;
  });
}

/**
 * Run `loader` for `key` unless an identical run is already in flight, then
 * await it either way.
 *
 * This is the cold-miss dedup. The check has to happen *before* awaiting and
 * the marker has to be set *before* the loader's first await — otherwise two
 * callers both observe an empty map and both start a query, which is the exact
 * stampede this exists to prevent.
 *
 * `loader` (rather than the bare query) is what gets wrapped, so the winning
 * caller's `put` lands in `store` exactly once and every awaiter sees that same
 * value. `finally` clears the marker, so a rejection leaves the key clean and
 * the next reader retries rather than awaiting a dead promise forever.
 */
async function runOnce<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = loader().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/** Drop every cached entry whose key starts with `prefix`. */
export function invalidatePrefix(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

/**
 * Drop one cached entry by exact key.
 *
 * `invalidatePrefix("settings")` would also work today, but it scans the whole
 * key space on every settings write, and the intent ("this one value changed")
 * is clearer at the call site. An in-flight run is deliberately NOT cancelled:
 * the promise cannot be aborted, and dropping its `inflight` marker would only
 * let a second query start while the first is still writing. The write path
 * calls this and then overwrites the row, so the worst case is that one
 * in-flight reader gets the pre-write value — the same window every other
 * cache invalidation here already has.
 */
export function invalidate(key: string): void {
  store.delete(key);
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

/**
 * Hard-TTL memo: past `ttl` the entry is dropped and `fn` is awaited, with no
 * stale-while-revalidate window.
 *
 * For reads whose staleness shows up as a wrong setting, SWR is the wrong
 * trade. The active theme is the case in point: under SWR the entry survives
 * SWR_WINDOW * ttl, so a switch stayed invisible for up to 150s - and since
 * the store is per-process, `invalidateActiveThemeCache()` only cleared the
 * instance that served the PATCH. On Vercel the next visitor landed on another
 * instance and got the previous theme's chrome, which is what made switching
 * look random (A -> B -> default landing back on A).
 */
export async function memoStrict<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttl) {
    touch(key);
    return hit.value as T;
  }
  return runOnce(key, async () => {
    const value = await fn();
    put(key, { at: Date.now(), value });
    return value;
  });
}

/**
 * Current entry count. Exists for the eviction test in tools/cache-evict-check.mts:
 * the bound is invisible from the outside (nothing reports "the cache dropped an
 * entry"), so without a way to read the size it could only be verified by
 * reasoning about the code rather than by exercising it.
 */
export function cacheSize(): number {
  return store.size;
}

/** The ceiling `put` enforces. Exported for the same reason as cacheSize. */
export const CACHE_MAX_ENTRIES = MAX_ENTRIES;
