/**
 * Media library service — ported from lib/services/media.ts.
 *
 * Uploads need media:upload (admin/editor/author, like the original);
 * listing needs any session; delete/edit are owner-or-content:update:any.
 * Every read hits the live database.
 */
import { desc, eq, sql } from "drizzle-orm";
import { db } from "./db.js";
import { media as mediaTable, type Media } from "./schema.js";
import type { SessionUser } from "./auth.js";
import { can, requireUser, ServiceError } from "./admin.js";
import { uploadFile, deleteFile } from "./storage.js";

export async function listMedia(
  user: SessionUser | null,
  limit = 50,
  offset = 0,
): Promise<{ items: Media[]; total: number }> {
  requireUser(user);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = await db
    .select()
    .from(mediaTable)
    .orderBy(desc(mediaTable.createdAt))
    .limit(n)
    .offset(Math.max(0, offset));
  const [c] = await db.select({ n: sql<number>`count(*)` }).from(mediaTable);
  return { items: rows, total: Number(c?.n ?? 0) };
}

export async function getMedia(id: number): Promise<Media> {
  const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, id));
  if (!row) throw new ServiceError("媒体不存在", 404);
  return row;
}

export async function createMediaFromFile(
  userIn: SessionUser | null,
  file: File,
  alt = "",
): Promise<Media> {
  const user = requireUser(userIn);
  if (!can(user.role, "media:upload")) throw new ServiceError("无权上传媒体", 403);
  const result = await uploadFile(file, "media");
  const storedName = result.url.split("?")[0].split("/").pop() || file.name;
  const note = alt.trim() || file.name;
  const [row] = await db
    .insert(mediaTable)
    .values({
      filename: storedName,
      url: result.url,
      mimeType: result.contentType,
      size: result.size,
      alt: note,
      uploadedById: user.id,
    })
    .returning();
  return row;
}

function canManage(user: SessionUser, existing: Media): void {
  const isOwner = existing.uploadedById === user.id;
  if (!isOwner && !can(user.role, "content:update:any"))
    throw new ServiceError("无权操作该媒体", 403);
}

export async function deleteMedia(userIn: SessionUser | null, id: number): Promise<{ id: number }> {
  const user = requireUser(userIn);
  const existing = await getMedia(id);
  canManage(user, existing);
  await deleteFile(existing.url).catch(() => {});
  await db.delete(mediaTable).where(eq(mediaTable.id, id));
  return { id };
}

export async function updateMedia(
  userIn: SessionUser | null,
  id: number,
  patch: { filename?: string; alt?: string },
): Promise<Media> {
  const user = requireUser(userIn);
  const existing = await getMedia(id);
  canManage(user, existing);
  const [row] = await db
    .update(mediaTable)
    .set({
      filename: patch.filename?.trim() || existing.filename,
      alt: patch.alt === undefined ? existing.alt : patch.alt,
    })
    .where(eq(mediaTable.id, id))
    .returning();
  return row;
}

export async function deleteMediaMany(
  userIn: SessionUser | null,
  ids: number[],
): Promise<{ deleted: number[]; skipped: number[] }> {
  const user = requireUser(userIn);
  const deleted: number[] = [];
  const skipped: number[] = [];
  for (const id of ids) {
    try {
      await deleteMedia(user, id);
      deleted.push(id);
    } catch {
      skipped.push(id);
    }
  }
  return { deleted, skipped };
}
