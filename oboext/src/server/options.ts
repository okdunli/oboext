// Generic key/value option store — port of lib/services/options.ts.
import { inArray, eq } from "drizzle-orm";
import { db } from "./db.js";
import { options } from "./schema.js";

// How long a cached option stays believable. The store is per-process, and a
// multi-instance deployment (Vercel: every warm instance serves reads) makes a
// write that lands on one instance invisible to the others until they re-read
// — with no TTL that means "until the process restarts", which is how a
// settings change could look like it never took effect. setOption() refreshes
// the entry's timestamp, so the writing instance stays instantly correct; the
// TTL only bounds how long the others may serve the previous value. Same
// eventual-consistency contract hotCache (10s) and the permalink memo (30s)
// already run on. Exported so the test can sleep exactly past it.
export const OPTION_TTL_MS = 5_000;

const cache = new Map<string, { at: number; value: unknown }>();

/** Serve-without-DB decision, split out for the boundary test. */
export function optionFresh(at: number, now: number): boolean {
  return now - at < OPTION_TTL_MS;
}

export async function getOption<T = unknown>(key: string, fallback?: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && optionFresh(hit.at, Date.now())) return hit.value as T;
  const [row] = await db.select().from(options).where(eq(options.key, key));
  const value = (row?.value ?? fallback) as T;
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function getOptions(keys: string[]): Promise<Record<string, unknown>> {
  if (!keys.length) return {};
  const rows = await db.select().from(options).where(inArray(options.key, keys));
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setOption(key: string, value: unknown): Promise<void> {
  await db
    .insert(options)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: options.key,
      set: { value, updatedAt: new Date() },
    });
  // Refresh the timestamp together with the value: the writing instance must
  // see its own write instantly, and a stale `at` would make the very next
  // read re-query for nothing.
  cache.set(key, { at: Date.now(), value });
}

export async function deleteOption(key: string): Promise<void> {
  await db.delete(options).where(eq(options.key, key));
  cache.delete(key);
}

export function invalidateOptionCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
