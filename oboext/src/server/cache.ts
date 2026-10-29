import { createLogger } from "./logger.js";
const log = createLogger("cache");
// In-process SWR memo for read queries — the data-layer half of Oboext's caching story.
const store = new Map<
  string,
  { at: number; value: unknown; refreshing?: Promise<unknown> }
>();

// In-flight query promises, keyed the same as `store`.
const inflight = new Map<string, Promise<unknown>>();

export const SIDEBAR_TTL = 30_000;

/** How long a stale entry may keep serving while a background refresh runs. */
const SWR_WINDOW = 5;

// Hard ceiling on entries, so a key space that includes request input cannot grow the store without bound.
const MAX_ENTRIES = 512;

// Insert, or refresh an existing entry, then enforce the ceiling. Called on every WRITE and on every cache HIT.
function put(key: string, entry: { at: number; value: unknown }): void {
  // Carrying the in-flight refresh marker across the rewrite matters: dropping it would let a second background refresh start for a key that already.
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

// Move a key to the most-recent position without rewriting its entry.
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
      // Serve stale immediately; refresh once in the background. Concurrent
      // askers share the same in-flight refresh (no thundering herd).
      if (!hit.refreshing) {
        hit.refreshing = fn()
          .then((value) => {
            put(key, { at: Date.now(), value });
            // Clear the in-flight marker on SUCCESS too. put() deliberately
            // carries `refreshing` forward so a concurrent stale read does not
            // start a second refresh mid-flight; but if it is never cleared, the
            // marker survives as a RESOLVED promise, so every later stale read
            // sees `refreshing` truthy and skips the background refresh - the
            // entry then serves stale until the full SWR_WINDOW*ttl and only
            // refreshes once per window instead of once per ttl.
            const cur = store.get(key);
            if (cur) cur.refreshing = undefined;
            return value;
          })
          .catch((e) => {
            // Refresh failed: keep serving the stale value until the next window; drop the in-flight marker so a later read retries.
            log.warn(
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

// The framework KV (globalThis.__rosezmKvApi.kv) offers get/set/del/has but no
// prefix scan, and the loaders key it with DYNAMIC names
// (cat:<slug>:<page>:<theme>, archives:<year>:<month>, ...). The loader
// comments used to claim "an admin write invalidates by TTL" - nothing ever
// deleted these entries, so a freshly published post stayed off the home page
// for a full TTL. Every set is therefore REGISTERED here, and a content write
// drops them all.
const kvKeys = new Set<string>();

type KvApi = {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlSeconds?: number): void;
  del(key: string): void;
  has(key: string): boolean;
};

function kvApi(): KvApi | undefined {
  return (globalThis as Record<string, unknown>).__rosezmKvApi as
    | { kv?: KvApi }
    | undefined;
}

/** Read a loader KV entry (undefined when the framework shipped no KV). */
export function kvGet<T>(key: string): T | undefined {
  return kvApi()?.kv.get(key) as T | undefined;
}

/** Write a loader KV entry; the key is registered for content-write invalidation. */
export function kvSet(key: string, value: unknown, ttlSeconds: number): void {
  kvKeys.add(key);
  kvApi()?.kv.set(key, value, ttlSeconds);
}

/** Drop every loader KV entry - the KV half of a content write. */
export function invalidateKvContent(): void {
  const kv = kvApi()?.kv;
  if (!kv) return;
  for (const k of kvKeys) kv.del(k);
  kvKeys.clear();
}

/**
 * Drop every entry a content write can stale: taxonomies, counts, the archive
 * timeline, popular/recent lists, generic post listings, widget data and the
 * routed slug lookups (public pages, post tails). Called from
 * post/tag/category/page/comment write paths so the sidebar and routed content
 * refresh immediately instead of waiting out the TTL.
 */
export function invalidateContentCaches(): void {
  invalidatePrefix("tax:");
  invalidatePrefix("counts");
  invalidatePrefix("archive");
  invalidatePrefix("popular");
  invalidatePrefix("lp:");
  invalidatePrefix("pin:");
  invalidatePrefix("sred:");
  invalidatePrefix("rel:");
  invalidatePrefix("reltax:");
  invalidatePrefix("adj:");
  invalidatePrefix("rand:");
  invalidatePrefix("cmts:");
  invalidatePrefix("widget:");
  invalidatePrefix("pathmiss:");
  invalidatePrefix("pg:");
  invalidatePrefix("pgh:");
  invalidatePrefix("hydr:");
  invalidatePrefix("rp:");
  // R149: verifyToken memoizes the identity row (`sess:<id>`). Every users-row
  // write that matters rides this function - admin updateUser (ban / role /
  // rename) and deleteUser both call it at their commit point - so dropping the
  // prefix here is what keeps "a ban is instant" true while steady-state
  // authenticated requests stop paying the per-request read. Content writes
  // dropping it too is harmless (one re-read) and buys freshness for author
  // renames visible through other memos.
  invalidatePrefix("sess:");
  // R150: memoized document bodies (feed/jsonFeed/commentsFeed keyed
  // `doc:feed|json|comments:<origin>:<locale>`, the sitemap skeleton
  // `doc:sitemap:<base>`) - content-derived strings/entries rebuilt from the
  // same rows this function already invalidates, so they drop here too and a
  // publish/approve shows up on the very next render instead of waiting the
  // 30s TTL.
  invalidatePrefix("doc:");
  // R156: the public search surfaces memoize their answers (`sq:suggest:<q>`
  // in /api/search-suggest, `sq:posts:<sig>` in the guest branch of
  // /api/posts). Both derive from published rows, so a publish/approve must
  // show up on the next keystroke rather than after the 20s TTL.
  invalidatePrefix("sq:");
  // The loader KV entries (home bundle, sidebars, category lists, archives)
  // are content-derived too - drop them in the same breath.
  invalidateKvContent();
  // R267: this function runs at the COMMIT POINT of every content write (that
  // is what the comment below says), which makes it the one honest place to
  // tell the database layer that the on-disk data moved. Without it the
  // recovery snapshot was only ever written on a clean shutdown - measured 18
  // minutes stale in this repo while the server ran - so a crash rolled the
  // database back to the last clean close. Dynamic import: cache must not gain
  // a static dependency on db (the layering runs the other way).
  void import("./db.js").then((db) => db.markDataChanged()).catch(() => {});
  // R274: the same commit point re-probes whether translation pairing exists.
  // Creating/unlinking a pair must flip canonicalPath/hreflangLinks semantics
  // on the very next render, not after a process restart. Dynamic import keeps
  // cache free of a static db dependency (same layering as the line above);
  // i18n stays dependency-free because the probe lands in loaders, which
  // writes the flag through i18n's setPairingActive.
  void import("./db.js")
    .then(async (db) => {
      const rows = await db.rawQuery<{ n: number }>(
        `select count(*)::int as n from posts where translation_of is not null`,
      );
      const i18n = await import("./i18n.js");
      i18n.setPairingActive(Number(rows[0]?.n ?? 0) > 0);
    })
    .catch(() => {});
  // BUG.md W: the response caches (Rosezm prod-server hotCache + render
  // cache) invalidate at request boundaries, which leaves a window where an
  // in-flight warm render stores pre-mutation bytes. This function runs at
  // the COMMIT POINT of every content write, so it is the one place that can
  // tell the server "the world changed NOW". Since the R58 framework upgrade
  // the prod-server exposes that hook natively
  // (globalThis.__rosezmInvalidateHot, rosezm R56); absent (dev server) it is
  // a no-op. The build-time patch that used to install it is gone.
  const invalidateHot = (globalThis as Record<string, unknown>).__rosezmInvalidateHot;
  if (typeof invalidateHot === "function") (invalidateHot as () => void)();
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
 * Read a memoized value without triggering a load. Undefined when absent.
 * For negative-result caches: the caller stores a flag once a miss is
 * confirmed, then peeks before doing the work the miss makes pointless.
 *
 * Pass `ttl` to also honor an expiry. Without it a peek ignores the entry's
 * age entirely, so a negative flag written under a 60s TTL stayed "true" for
 * the life of the process — until an LRU eviction or an explicit invalidate.
 * That is how one transient resolver failure pinned an otherwise valid URL to
 * 404 on that instance, which is exactly what the TTL was meant to bound.
 */
export function peekMemo<T = unknown>(key: string, ttl?: number): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (ttl !== undefined && Date.now() - hit.at >= ttl) return undefined;
  return hit.value as T;
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
    // touch(), not put(): a hit must refresh recency so the key is not the
    // next one evicted, but it must NOT move `at` forward — that is the TTL
    // clock, and sliding it on every read would make the TTL a no-op for any
    // key that is polled.
    touch(key);
    return hit.value as T;
  }
  // Same cold-miss dedup as memo(): without it every concurrent reader of a
  // not-yet-cached key issues its own query, which is how one /archives render
  // selected `site_settings` six times before this existed.
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
