import { eq, inArray } from "drizzle-orm";
import { db } from "./db.js";
import { pageMetas, postMetas } from "./schema.js";

export type MetaInput = { key: string; value: string };

/**
 * Trim keys, drop empties, cap key length, and DEDUPE by key (last value wins).
 * post_metas/page_metas have no unique(postId, key) constraint, so without the
 * dedupe a submit carrying the same key twice inserts duplicate rows that pile
 * up across saves; getPostMetas silently collapses them last-wins on read, so
 * the write side must collapse the same way. Exported for the unit test.
 */
export function cleanMetas(metas: MetaInput[]): { key: string; value: string }[] {
  const byKey = new Map<string, string>();
  for (const m of metas) {
    const key = String(m.key ?? "").trim().slice(0, 100);
    if (key.length === 0) continue;
    byKey.set(key, String(m.value ?? ""));
  }
  return [...byKey].map(([key, value]) => ({ key, value }));
}

const clean = cleanMetas;

// --------------------------------------------------------------------- posts

/** All custom fields of a post as a key→value map. */
export async function getPostMetas(postId: number): Promise<Record<string, string>> {
  const rows = await db.select().from(postMetas).where(eq(postMetas.postId, postId));
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value ?? "";
  return out;
}

/** Replace the entire custom-field set of a post. */
export async function setPostMetas(postId: number, metas: MetaInput[]): Promise<void> {
  await db.delete(postMetas).where(eq(postMetas.postId, postId));
  const rows = clean(metas).map((m) => ({ postId, key: m.key, value: m.value }));
  if (rows.length) await db.insert(postMetas).values(rows);
}

// Batch variant for list reads: one query for the whole page of posts (mirror posts.ts attachMetas). Missing ids simply stay absent.
export async function attachPostMetas(
  ids: number[],
): Promise<Record<number, Record<string, string>>> {
  const out: Record<number, Record<string, string>> = {};
  if (!ids.length) return out;
  const rows = await db.select().from(postMetas).where(inArray(postMetas.postId, ids));
  for (const r of rows) {
    if (!out[r.postId]) out[r.postId] = {};
    out[r.postId][r.key] = r.value ?? "";
  }
  return out;
}

// --------------------------------------------------------------------- pages

/** All custom fields of a static page as a key→value map. */
export async function getPageMetas(pageId: number): Promise<Record<string, string>> {
  const rows = await db.select().from(pageMetas).where(eq(pageMetas.pageId, pageId));
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value ?? "";
  return out;
}

/** Replace the entire custom-field set of a static page. */
export async function setPageMetas(pageId: number, metas: MetaInput[]): Promise<void> {
  await db.delete(pageMetas).where(eq(pageMetas.pageId, pageId));
  const rows = clean(metas).map((m) => ({ pageId, key: m.key, value: m.value }));
  if (rows.length) await db.insert(pageMetas).values(rows);
}
