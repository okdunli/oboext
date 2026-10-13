

import { eq, inArray } from "drizzle-orm";
import { db } from "./db.js";
import { pageMetas, postMetas } from "./schema.js";

export type MetaInput = { key: string; value: string };

/** Trim keys, drop empties, cap key length (mirror pages.ts validation). */
function clean(metas: MetaInput[]): { key: string; value: string }[] {
  return metas
    .map((m) => ({ key: String(m.key ?? "").trim(), value: String(m.value ?? "") }))
    .filter((m) => m.key.length > 0)
    .map((m) => ({ key: m.key.slice(0, 100), value: m.value }));
}

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

/**
 * Batch variant for list reads: one query for the whole page of posts
 * (mirror posts.ts attachMetas). Missing ids simply stay absent.
 */
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
