/**
 * Generic key/value option store — port of lib/services/options.ts.
 *
 * Values are stored as jsonb so any serialisable shape works. A tiny
 * per-process cache keeps hot reads (notify/permalink configs) from hitting
 * the DB repeatedly; setOption/deleteOption invalidate it.
 */
import { inArray, eq } from "drizzle-orm";
import { db } from "./db.js";
import { options } from "./schema.js";

const cache = new Map<string, unknown>();

export async function getOption<T = unknown>(key: string, fallback?: T): Promise<T> {
  if (cache.has(key)) return cache.get(key) as T;
  const [row] = await db.select().from(options).where(eq(options.key, key));
  const value = (row?.value ?? fallback) as T;
  cache.set(key, value);
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
  cache.set(key, value);
}

export async function deleteOption(key: string): Promise<void> {
  await db.delete(options).where(eq(options.key, key));
  cache.delete(key);
}

export function invalidateOptionCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
