/**
 * Media library service — ported from lib/services/media.ts.
 *
 * Uploads need media:upload (admin/editor/author, like the original);
 * listing needs any session; delete/edit are owner-or-content:update:any.
 * Every read hits the live database.
 */
import { and, asc, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { db } from "./db.js";
import { media as mediaTable, posts, pages, type Media } from "./schema.js";
import type { SessionUser } from "./auth.js";
import { can, requireUser, ServiceError } from "./admin.js";
import { uploadFile, deleteFile, uploadsAbsPath } from "./storage.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { invalidateVariantCache } from "./render.js";

const execFileP = promisify(execFile);

/** Widths generated for every image upload (F2e responsive variants). */
export const VARIANT_WIDTHS = [400, 800, 1600];

/** /uploads/media/foo.jpg -> /uploads/media/foo.w400.jpg */
function variantUrl(url: string, w: number): string {
  return url.replace(/(\.[a-z0-9]+)(?=\?|$)/i, (_m, ext) => `.w${w}${ext}`);
}

/**
 * Variant status for one media item: which `.wNNN` siblings exist on disk.
 * Images uploaded before variants shipped (or whose generation failed) show
 * up as missing here and can be filled in by regenerateMediaVariants.
 */
export async function getMediaVariants(
  userIn: SessionUser | null,
  id: number,
): Promise<{ id: number; url: string; isImage: boolean; variants: Array<{ width: number; url: string; exists: boolean; size: number }>; missing: number[]; available: boolean }> {
  const user = requireUser(userIn);
  const existing = await getMedia(id);
  canManage(user, existing);
  const isImage = /\.(jpe?g|png)$/i.test(existing.url);
  const variants = VARIANT_WIDTHS.map((width) => ({ width, url: variantUrl(existing.url, width), exists: false, size: 0 }));
  if (!isImage) return { id: existing.id, url: existing.url, isImage: false, variants, missing: [], available: false };
  const abs = uploadsAbsPath(existing.url);
  if (!abs) return { id: existing.id, url: existing.url, isImage: true, variants, missing: VARIANT_WIDTHS.slice(), available: false };
  const ext = path.extname(abs);
  const base = abs.slice(0, -ext.length);
  for (const v of variants) {
    const p = base + `.w${v.width}` + ext;
    try {
      const st = await fs.promises.stat(p);
      if (st.isFile()) {
        v.exists = true;
        v.size = st.size;
      }
    } catch { /* not generated yet */ }
  }
  return {
    id: existing.id,
    url: existing.url,
    isImage: true,
    variants,
    missing: variants.filter((v) => !v.exists).map((v) => v.width),
    available: true,
  };
}

/**
 * Fill in the variants a media item is missing. generateImageVariants skips
 * widths already on disk, so this is idempotent: it only does the work that
 * is actually outstanding, then drops the render cache so the srcset appears.
 */
export async function regenerateMediaVariants(userIn: SessionUser | null, id: number) {
  const user = requireUser(userIn);
  const existing = await getMedia(id);
  canManage(user, existing);
  if (!/\.(jpe?g|png)$/i.test(existing.url)) throw new ServiceError("仅图片支持变体", 400);
  const abs = uploadsAbsPath(existing.url);
  if (!abs) throw new ServiceError("无法定位文件", 400);
  await generateImageVariants(abs);
  invalidateVariantCache(existing.url);
  return getMediaVariants(user, id);
}

/**
 * Generate `.wNNN` variants beside an uploaded image through PowerShell's
 * System.Drawing (GDI+ - every Windows box has it, zero npm deps). Never
 * upscales; skips widths whose variant file already exists. JPEG re-encodes
 * at quality 82, PNG stays PNG. Fire-and-forget by design: the upload
 * responds immediately and the variants land a second later, after which the
 * render cache for the URL is invalidated so the srcset appears.
 */
async function generateImageVariants(abs: string): Promise<void> {
  if (!/\.(jpe?g|png)$/i.test(abs)) return;
  const ext = path.extname(abs);
  const jpeg = /\.jpe?g$/i.test(abs);
  const jobs = VARIANT_WIDTHS.filter((w) => !fs.existsSync(abs.slice(0, -ext.length) + `.w${w}` + ext))
    .map((w) => ({ s: abs, d: abs.slice(0, -ext.length) + `.w${w}` + ext, w, jpeg }));
  if (!jobs.length) return;
  const ps = `
$jobs = ${JSON.stringify(JSON.stringify(jobs))} | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
foreach ($j in $jobs) {
  $src = [System.Drawing.Image]::FromFile($j.s)
  try {
    if ($src.Width -le $j.w) { continue }
    $h = [int][Math]::Round($src.Height * $j.w / $src.Width)
    $bmp = New-Object System.Drawing.Bitmap($j.w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $j.w, $h)
    $g.Dispose()
    if ($j.jpeg) {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
      $bmp.Save($j.d, $codec, $ep)
    } else {
      $bmp.Save($j.d, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $bmp.Dispose()
  } finally { $src.Dispose() }
}`;
  await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 120_000 });
}

/**
 * Media library listing. `q` matches the filename or the alt text, `type`
 * splits images from everything else, `tag` filters by one tag word. The
 * order is the manual drag order (`sort_order`) first, then newest first —
 * every row starts at 0, so a library that was never reordered keeps the
 * newest-first order it always had, and a fresh upload (also 0) still lands
 * on top of an explicitly ordered library until the next reorder folds it in.
 * The filter is applied server-side so the total is the filtered total, not
 * the size of the whole library.
 */
export async function listMedia(
  user: SessionUser | null,
  limit = 50,
  offset = 0,
  filter: { q?: string; type?: string; tag?: string } = {},
): Promise<{ items: Media[]; total: number }> {
  requireUser(user);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const conds: SQL[] = [];
  const q = String(filter.q || "").trim();
  if (q) {
    const like = `%${q}%`;
    conds.push(or(sql`${mediaTable.filename} ILIKE ${like}`, sql`${mediaTable.alt} ILIKE ${like}`)!);
  }
  const type = String(filter.type || "").trim();
  if (type === "image") conds.push(sql`${mediaTable.mimeType} LIKE 'image/%'`);
  else if (type === "doc") conds.push(sql`NOT (${mediaTable.mimeType} LIKE 'image/%')`);
  const tag = String(filter.tag || "").trim();
  if (tag) conds.push(sql`${mediaTable.tags} ILIKE ${"%" + tag + "%"}`);
  const where: SQL = conds.length ? and(...conds)! : sql`true`;
  const rows = await db
    .select()
    .from(mediaTable)
    .where(where)
    .orderBy(asc(mediaTable.sortOrder), desc(mediaTable.createdAt))
    .limit(n)
    .offset(Math.max(0, offset));
  const [c] = await db.select({ n: sql<number>`count(*)` }).from(mediaTable).where(where);
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
  const abs = uploadsAbsPath(result.url);
  if (abs) {
    void generateImageVariants(abs)
      .then(() => invalidateVariantCache(result.url))
      .catch(() => invalidateVariantCache(result.url));
  }
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
  const abs = uploadsAbsPath(existing.url);
  if (abs && /\.(jpe?g|png)$/i.test(abs)) {
    const ext = path.extname(abs);
    const base = abs.slice(0, -ext.length);
    for (const w of VARIANT_WIDTHS) void fs.promises.unlink(base + `.w${w}` + ext).catch(() => {});
  }
  await db.delete(mediaTable).where(eq(mediaTable.id, id));
  return { id };
}

export async function updateMedia(
  userIn: SessionUser | null,
  id: number,
  patch: { filename?: string; alt?: string; tags?: string },
): Promise<Media> {
  const user = requireUser(userIn);
  const existing = await getMedia(id);
  canManage(user, existing);
  const [row] = await db
    .update(mediaTable)
    .set({
      filename: patch.filename?.trim() || existing.filename,
      alt: patch.alt === undefined ? existing.alt : patch.alt,
      tags: patch.tags === undefined ? existing.tags : normalizeTags(patch.tags),
    })
    .where(eq(mediaTable.id, id))
    .returning();
  return row;
}

/**
 * Tags are stored comma-separated in one text column — a taxonomy for a few
 * dozen library labels would be machinery without a user. Splitting accepts
 * ASCII/Chinese commas and spaces, so "旅行, 摄影" and "旅行 摄影" land the
 * same. Case is preserved (tags may be meaningful filenames), dedupe is
 * exact-match after trim.
 */
export function normalizeTags(input: string): string {
  return Array.from(
    new Set(
      String(input || "")
        .split(/[,，、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ).join(",");
}

function parseTags(stored: string | null): string[] {
  return String(stored || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Batch tagging: `replace` overwrites the selected items' tags, `add` merges
 * into them (per-item unique — an item already carrying the tag is unchanged).
 * Every id is permission-checked individually and failures are skipped, the
 * same contract bulk delete uses.
 */
export async function tagMediaMany(
  userIn: SessionUser | null,
  ids: number[],
  tags: string,
  mode: "add" | "replace",
): Promise<{ updated: number[]; skipped: number[] }> {
  const user = requireUser(userIn);
  const wanted = normalizeTags(tags);
  if (!wanted) throw new ServiceError("标签不能为空", 400);
  if (mode !== "add" && mode !== "replace") throw new ServiceError("无效模式", 400);
  const wantedArr = parseTags(wanted);
  const updated: number[] = [];
  const skipped: number[] = [];
  for (const id of ids) {
    try {
      const existing = await getMedia(id);
      canManage(user, existing);
      const next =
        mode === "replace"
          ? wanted
          : normalizeTags([...parseTags(existing.tags), ...wantedArr].join(","));
      await db.update(mediaTable).set({ tags: next }).where(eq(mediaTable.id, id));
      updated.push(id);
    } catch {
      skipped.push(id);
    }
  }
  return { updated, skipped };
}

/**
 * Persist a manual drag order. The client only knows the items it has loaded,
 * so the renumber covers the WHOLE library: the sent ids keep the relative
 * order the user just arranged, and every row the client never saw trails
 * after them in its previous display order. Each reorder writes a full 1..M
 * sequence, which keeps the order stable across pages and filters.
 */
export async function reorderMedia(
  userIn: SessionUser | null,
  ids: number[],
): Promise<{ ordered: number }> {
  const user = requireUser(userIn);
  if (!can(user.role, "content:update:any")) throw new ServiceError("无权排序媒体", 403);
  const all = await db
    .select({ id: mediaTable.id })
    .from(mediaTable)
    .orderBy(asc(mediaTable.sortOrder), desc(mediaTable.createdAt));
  const rank = new Map(all.map((r, i) => [r.id, i]));
  const sent = ids.filter((id) => rank.has(id));
  const sentSet = new Set(sent);
  const rest = all.map((r) => r.id).filter((id) => !sentSet.has(id));
  const order = [...sent, ...rest];
  if (!order.length) return { ordered: 0 };
  const cases = sql.join(
    order.map((id, i) => sql`when ${mediaTable.id} = ${id} then ${i + 1}`),
    sql` `,
  );
  await db.execute(
    sql`update ${mediaTable} set sort_order = case ${cases} else sort_order end`,
  );
  return { ordered: order.length };
}

/**
 * Where a media item is referenced: featured images match on the URL column,
 * inline usage is found through the jsonb content's text form (the blocks are
 * structured, so a LIKE over their serialization is the honest way to look).
 * Used to warn before a delete instead of silently breaking N pages.
 */
export async function getMediaUsage(
  userIn: SessionUser | null,
  id: number,
): Promise<{ id: number; url: string; count: number; posts: Array<{ id: number; title: string; slug: string }>; pages: Array<{ id: number; title: string; slug: string }> }> {
  const user = requireUser(userIn);
  const m = await getMedia(id);
  const like = `%${m.url}%`;
  const hit = or(eq(posts.featuredImage, m.url), sql`${posts.content}::text LIKE ${like}`);
  const hitP = or(eq(pages.featuredImage, m.url), sql`${pages.content}::text LIKE ${like}`);
  const [p, g] = await Promise.all([
    db.select({ id: posts.id, title: posts.title, slug: posts.slug }).from(posts).where(hit!),
    db.select({ id: pages.id, title: pages.title, slug: pages.slug }).from(pages).where(hitP!),
  ]);
  return { id: m.id, url: m.url, count: p.length + g.length, posts: p, pages: g };
}

/**
 * Fill in the variants every image is missing - the catch-up pass for a
 * library that predates variants (or lost some to a failed generation).
 * Idempotent: an image that already has all three is not touched.
 */
export async function regenerateAllVariants(
  userIn: SessionUser | null,
): Promise<{ checked: number; regenerated: number; failed: number }> {
  const user = requireUser(userIn);
  if (!can(user.role, "content:update:any")) throw new ServiceError("无权批量生成变体", 403);
  const rows = await db.select().from(mediaTable).orderBy(desc(mediaTable.createdAt));
  let checked = 0;
  let regenerated = 0;
  let failed = 0;
  for (const m of rows) {
    if (!/\.(jpe?g|png)$/i.test(m.url)) continue;
    checked++;
    try {
      const before = await getMediaVariants(user, m.id);
      if (!before.missing.length) continue;
      await regenerateMediaVariants(user, m.id);
      regenerated++;
    } catch {
      failed++;
    }
  }
  return { checked, regenerated, failed };
}

/**
 * Swap the bytes behind an existing media item WITHOUT changing its URL.
 * That is the whole point: post and page content references the image by URL,
 * so re-uploading (which mints a new random filename) would silently break
 * every reference - the usage check would go from N to 0 with no error.
 * The old image's variants are dropped and rebuilt, because they are now
 * thumbnails of a picture that no longer exists.
 */
export async function replaceMediaFile(
  userIn: SessionUser | null,
  id: number,
  file: File,
): Promise<Media> {
  const user = requireUser(userIn);
  if (!can(user.role, "media:upload")) throw new ServiceError("无权上传媒体", 403);
  const existing = await getMedia(id);
  canManage(user, existing);
  const abs = uploadsAbsPath(existing.url);
  if (!abs) throw new ServiceError("无法定位原文件", 400);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.promises.writeFile(abs, buffer);
  const ext = path.extname(abs);
  const base = abs.slice(0, -ext.length);
  for (const w of VARIANT_WIDTHS) void fs.promises.unlink(base + `.w${w}` + ext).catch(() => {});
  invalidateVariantCache(existing.url);
  if (/\.(jpe?g|png)$/i.test(abs)) {
    void generateImageVariants(abs)
      .then(() => invalidateVariantCache(existing.url))
      .catch(() => invalidateVariantCache(existing.url));
  }
  const [row] = await db
    .update(mediaTable)
    .set({
      mimeType: file.type || existing.mimeType,
      size: buffer.length,
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
