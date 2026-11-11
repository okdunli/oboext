// Media library service — ported from lib/services/media.ts.
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "./db.js";
import { media as mediaTable, posts, pages, type Media } from "./schema.js";
import type { SessionUser } from "./auth.js";
import { can, requireCap, requireUser, ServiceError } from "./admin.js";
import { uploadBuffer, deleteFile, uploadsAbsPath, uploadExists, invalidateUploadExists, sniffMime, mimeFor, UPLOADS_DIR } from "./storage.js";
import fs from "node:fs";
import path from "node:path";
import { invalidateVariantCache } from "./render.js";
import { variantEngine, generateVariants, type VariantJob } from "./variant-engines.js";
import { createLogger } from "./logger.js";
import { normalizeWindow, ilikeEscape } from "./queries.js";
import { recordAdminAction } from "./security-events.js";
const log = createLogger("media");


// Media-library uploads are served straight from the app origin, so an
// executable / active-document type (.js, .mjs, .html, .svg, ...) is a stored-XSS
// vector: a visitor who opens the raw URL runs attacker script in the site
// origin. Allowlist the types a blog media library actually needs; reject
// everything else. (Theme/plugin assets install through a separate admin path
// and are not subject to this.) Serving also sets nosniff (storage.ts), which
// covers content/extension mismatch, but an ALLOWED active type would still run
// - hence the allowlist excludes them outright.
const MEDIA_ALLOWED_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".pdf", ".txt", ".md", ".csv", ".json",
  ".mp3", ".wav", ".ogg", ".m4a",
  ".mp4", ".webm",
  ".woff", ".woff2", ".ttf",
]);

export function assertMediaTypeAllowed(name: string): void {
  const ext = path.extname(name || "").toLowerCase();
  if (!MEDIA_ALLOWED_EXT.has(ext)) {
    throw new ServiceError(
      `不支持的文件类型${ext ? `：${ext}` : ""}`,
      415,
      "api.media_type",
    );
  }
}

// Upload size ceiling. The dev server caps request bodies at rosezm_MAX_BODY
// (tools/serve.mjs sets 25MB), but the production server streams the body with
// no such cap - so without this a huge upload would be written straight to disk
// (disk-fill DoS). 25MB default matches the dev cap; override per deployment.
export const MEDIA_MAX_BYTES = Math.max(
  1,
  Number(process.env.OBOEXT_MEDIA_MAX_BYTES) || 25 * 1024 * 1024,
);


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
    // `available` means "this host could have produced them", not "every
    // requested width exists". Reporting true on an engineless host would
    // tell the admin to retry a regeneration that can never succeed.
    available: (await variantEngine()) !== null,
  };
}

/**
 * Fill in the variants a media item is missing. generateImageVariants skips
 * widths already on disk, so this is idempotent: it only does the work that
 * is actually outstanding, then drops the render cache so the srcset appears.
 */
/**
 * Kick off variant generation without making the caller wait, and make sure a
 * failure is never silent.
 *
 * Both call sites (upload, replace) used `.then(invalidate).catch(invalidate)` -
 * identical handlers, so the cache was dropped either way and a total failure
 * (no engine on this host, a locked file, an out-of-memory resize) left exactly
 * the same trace as success. It is also why the platform bug survived: the
 * upload returned 200 and the only symptom was a srcset that never appeared.
 *
 * The cache is invalidated on BOTH paths deliberately - if a stale srcset is
 * cached, dropping it is the safe move regardless of what happened.
 */
function scheduleVariantGeneration(abs: string, url: string): void {
  void generateImageVariants(abs)
    .then((ok) => {
      if (!ok) log.warn(`[media] variants unavailable for ${url} on this host; serving the original only`);
      invalidateVariantCache(url);
    })
    .catch((e) => {
      log.error(`[media] variant generation failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
      invalidateVariantCache(url);
    });
}

/**
 * Drop every derived width for an image. Used twice - on upload of a new file
 * and on replace - and the two copies had drifted into identical one-liners
 * whose `catch(() => {})` threw away the only signal that a variant survived
 * on disk. A stale `.wNNN` is worse than none: the reader gets a thumbnail of
 * the PREVIOUS picture at the same URL.
 *
 * Reports what it could not remove so the caller can surface it instead of
 * pretending the library is clean.
 */
async function removeVariants(abs: string): Promise<string[]> {
  const ext = path.extname(abs);
  const base = abs.slice(0, -ext.length);
  const failed: string[] = [];
  await Promise.all(
    VARIANT_WIDTHS.map(async (w) => {
      const p = base + `.w${w}` + ext;
      try {
        await fs.promises.unlink(p);
      } catch (e) {
        // ENOENT is the normal case - most images never had every width.
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") failed.push(p);
      }
    }),
  );
  if (failed.length) log.error(`[media] could not remove stale variants: ${failed.join(", ")}`);
  return failed;
}

export async function regenerateMediaVariants(userIn: SessionUser | null, id: number) {
  const user = requireUser(userIn);
  const existing = await getMedia(id);
  canManage(user, existing);
  if (!/\.(jpe?g|png)$/i.test(existing.url)) throw new ServiceError("仅图片支持变体", 400);
  // A clear refusal beats a silent no-op: this endpoint is the manual retry
  // button, and on an engineless host it could only ever "succeed" while
  // producing nothing.
  const engine = await variantEngine();
  if (!engine) throw new ServiceError("当前部署环境无法生成图片变体（需要 Windows/GDI+、macOS/sips、ImageMagick 或 ffmpeg）", 501);
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
 *
 * Returns `false` when the host cannot do the work at all. Callers must NOT
 * treat that as success-with-nothing-to-do: on Linux this used to throw ENOENT
 * inside a fire-and-forget chain whose only rejection handler dropped a cache,
 * so the loss was invisible. Return a value, and let the caller decide.
 */
async function generateImageVariants(abs: string): Promise<boolean> {
  if (!/\.(jpe?g|png)$/i.test(abs)) return true;
  const ext = path.extname(abs);
  const base = abs.slice(0, -ext.length);
  const jobs: VariantJob[] = VARIANT_WIDTHS.filter(
    (w) => !fs.existsSync(`${base}.w${w}${ext}`),
  ).map((w) => ({ s: abs, d: `${base}.w${w}${ext}`, w, jpeg: /\.jpe?g$/i.test(abs) }));
  if (!jobs.length) return true;
  const engine = await generateVariants(jobs);
  if (!engine) {
    log.warn(`[media] variant generation skipped (no engine on ${process.platform}): ${abs}`);
    return false;
  }
  return true;
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
): Promise<{ items: Media[]; total: number; totalSize: number }> {
  // R264: `media:read` existed in the capability matrix with ZERO consumers
  // (grep found only its declarations). The gate here was requireUser — i.e.
  // "is signed in" — so a plain reader (subscriber) could list the media
  // library through /api/media, while the admin screen is adminOnly. Wiring the
  // capability it always had keeps authors working: author/editor/admin all
  // hold media:read; only subscriber does not.
  requireCap(user, "media:read");
  // R158: shared window clamp - `?offset=abc` used to reach .offset(NaN) and
  // `?limit=-5` a negative LIMIT (500s for any signed-in session).
  const { limit: n, offset: off } = normalizeWindow({ limit, offset }, 50);
  const conds: SQL[] = [];
  const q = String(filter.q || "").trim();
  // user input, so the wildcards must be escaped the same way every other
  // search in the app escapes them (ilikeEscape + ESCAPE '\') - a raw `%` would
  // match every row and `a_b` would also match `axb`.
  if (q) {
    const like = `%${ilikeEscape(q)}%`;
    conds.push(or(sql`${mediaTable.filename} ILIKE ${like} ESCAPE '\\'`, sql`${mediaTable.alt} ILIKE ${like} ESCAPE '\\'`)!);
  }
  const type = String(filter.type || "").trim();
  if (type === "image") conds.push(sql`${mediaTable.mimeType} LIKE 'image/%'`);
  else if (type === "doc") conds.push(sql`NOT (${mediaTable.mimeType} LIKE 'image/%')`);
  const tag = String(filter.tag || "").trim();
  if (tag) conds.push(sql`${mediaTable.tags} ILIKE ${"%" + ilikeEscape(tag) + "%"} ESCAPE '\\'`);
  // an always-true predicate keeps the two queries identical in shape
  const where: SQL = conds.length ? and(...conds)! : sql`true`;
  // R554: the row window, the filtered count and the library size sum are
  // mutually independent — one wave (the same shape adminListPosts has run
  // since R163). The admin media grid used to pay three serial round trips
  // on every load.
  const [rows, [c], [sz]] = await Promise.all([
    db
      .select()
      .from(mediaTable)
      .where(where)
      .orderBy(asc(mediaTable.sortOrder), desc(mediaTable.createdAt))
      .limit(n)
      .offset(off),
    db.select({ n: sql<number>`count(*)` }).from(mediaTable).where(where),
    // The size card is library-wide by design (unfiltered) — same key the
    // grid has always shown.
    db.select({ n: sql<number>`coalesce(sum(${mediaTable.size}), 0)::bigint` }).from(mediaTable),
  ]);
  // The admin grid paints one card per row; using the stored original meant a
  // library of phone photos pushed tens of MB for thumbnails (the upload cap
  // is 25MB). The 400px variant sits beside every image uploaded since
  // variants shipped; older rows and non-jpg/png formats fall back.
  const items = rows.map((row) =>
    String(row.mimeType ?? "").startsWith("image/")
      ? (() => {
          const thumbUrl = variantUrl(row.url, 400);
          const abs = uploadsAbsPath(thumbUrl);
          return abs && uploadExists(thumbUrl) ? { ...row, thumbUrl } : row;
        })()
      : row,
  );
  return { items, total: Number(c?.n ?? 0), totalSize: Number(sz?.n ?? 0) };
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
  assertMediaTypeAllowed(file.name);
  // A file whose extension claims a common image format must actually BE one:
  // sniffMime reads the magic number, which a client cannot fake. Catches the
  // text-file-named-.jpg that would land in the library as a broken image and
  // fail variant generation silently. (.ico/.bmp are not sniffable — skipped.)
  // R556: read the bytes ONCE. The sniff (image extensions), the size check
  // and the write all consume this one buffer — the old shape read
  // file.arrayBuffer() here AND again inside uploadBuffer, two full copies of
  // a file whose cap is 25 MB.
  const buffer = Buffer.from(await file.arrayBuffer());
  if (/\.(jpe?g|png|gif|webp|avif)$/.test(path.extname(file.name || "").toLowerCase())) {
    const sniffed = sniffMime(buffer);
    if (!sniffed) {
      throw new ServiceError("文件内容与扩展名不符（不是有效的图片）", 422, "api.media_not_image");
    }
  }
  if (buffer.length > MEDIA_MAX_BYTES) {
    throw new ServiceError(
      `文件过大（上限 ${Math.floor(MEDIA_MAX_BYTES / 1024 / 1024)}MB）`,
      413,
      "api.media_too_large",
    );
  }
  const result = await uploadBuffer(buffer, file.name, "media");
  // F2e: fire-and-forget responsive variants (.w400/.w800/.w1600 beside the
  // original, same PowerShell pipeline as tools/make-variants.mjs). The
  // upload responds immediately; the render cache for the URL drops its
  // "no variants yet" entry once the files exist, so the very next render
  // emits the srcset.
  const abs = uploadsAbsPath(result.url);
  if (abs) scheduleVariantGeneration(abs, result.url);
  // the stored filename mirrors the object on disk, like the original
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

/**
 * Re-register uploads that exist on disk but have no media row.
 *
 * The realistic way this state arises is an异常恢复: the DB rolls back to a
 * snapshot (damaged-directory sweep, a restore) while content/uploads is
 * untouched on disk — the files survive, the rows that made them visible in
 * the library do not. Until re-registered, an editor cannot see, tag or
 * re-embed those files anywhere (the library reads the table, not the disk).
 *
 * Responsive variants (.w400.jpg …) are skipped — they are derivatives of an
 * original and regenerate on demand. Files whose filename already has a row
 * are skipped, so the pass is idempotent.
 */
export async function syncOrphanUploads(
  userIn: SessionUser | null,
): Promise<{ registered: { id: number; filename: string; url: string }[]; skipped: number }> {
  const user = requireUser(userIn);
  if (!can(user.role, "content:update:any")) throw new ServiceError("仅编辑/管理员可扫描媒体", 403);
  const dir = path.join(UPLOADS_DIR, "media");
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => !n.startsWith("."));
  } catch {
    return { registered: [], skipped: 0 };
  }
  // Variants carry a .wNNNN segment before the extension: the original of
  // "x.w400.jpg" is "x.jpg", which the scan registers on its own pass.
  const originals = names.filter((n) => !/\.w\d{2,4}\.[a-z0-9]+$/i.test(n));
  const existing = new Set(
    (await db.select({ filename: mediaTable.filename }).from(mediaTable)).map((r) => r.filename),
  );
  const orphans = originals.filter((n) => !existing.has(n));
  const registered: { id: number; filename: string; url: string }[] = [];
  for (const name of orphans) {
    const abs = path.join(dir, name);
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) continue;
      const fh = await fs.promises.open(abs, "r");
      let head: Buffer;
      try {
        head = Buffer.alloc(32);
        const { bytesRead } = await fh.read(head, 0, 32, 0);
        head = head.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      const url = `/uploads/media/${encodeURIComponent(name)}`;
      const [row] = await db
        .insert(mediaTable)
        .values({
          filename: name,
          url,
          mimeType: sniffMime(head) || mimeFor(name),
          size: stat.size,
          alt: name,
          uploadedById: user.id,
        })
        .returning();
      registered.push({ id: row.id, filename: row.filename, url: row.url });
    } catch (err) {
      log.warn("[media] sync skipped " + name + ":", (err as Error)?.message);
    }
  }
  if (registered.length) recordAdminAction(user, "media.sync", { count: registered.length });
  return { registered, skipped: originals.length - orphans.length };
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
  await deleteFile(existing.url).catch(() => {}); // tolerate storage failures
  // F2e hygiene: the responsive variants are siblings of the original and are
  // NOT covered by deleteFile's single-URL unlink - leaving them behind would
  // orphan files the media library no longer knows about.
  const abs = uploadsAbsPath(existing.url);
  if (abs && /\.(jpe?g|png)$/i.test(abs)) {
    await removeVariants(abs);
  }
  await db.delete(mediaTable).where(eq(mediaTable.id, id));
  await recordAdminAction(user, "media.delete", { id });
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
  if (ids.length) {
    const rows = await db
      .select()
      .from(mediaTable)
      .where(inArray(mediaTable.id, ids));
    const present = new Map(rows.map((r) => [r.id, r]));
    const uniqueIds = [...new Set(ids)];
    const outcomes = await Promise.all(
      uniqueIds.map(async (id) => {
        const existing = present.get(id);
        if (!existing) return { id, ok: false as const };
        try {
          canManage(user, existing);
          const next =
            mode === "replace"
              ? wanted
              : normalizeTags([...parseTags(existing.tags), ...wantedArr].join(","));
          await db.update(mediaTable).set({ tags: next }).where(eq(mediaTable.id, id));
          return { id, ok: true as const };
        } catch {
          return { id, ok: false as const };
        }
      }),
    );
    for (const o of outcomes) (o.ok ? updated : skipped).push(o.id);
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
  const engine = await variantEngine();
  for (const m of rows) {
    if (!/\.(jpe?g|png)$/i.test(m.url)) continue;
    checked++;
    try {
      const abs = uploadsAbsPath(m.url);
      if (!abs) throw new ServiceError("无法定位文件", 400);
      const ext = path.extname(abs);
      const base = abs.slice(0, -ext.length);
      const missing: number[] = [];
      for (const width of VARIANT_WIDTHS) {
        try {
          const st = await fs.promises.stat(`${base}.w${width}${ext}`);
          if (st.isFile()) continue;
        } catch { /* not generated yet */ }
        missing.push(width);
      }
      if (!missing.length) continue;
      // A clear refusal beats a silent no-op: the same 501 the single-item
      // retry button throws on an engineless host.
      if (!engine) throw new ServiceError("当前部署环境无法生成图片变体（需要 Windows/GDI+、macOS/sips、ImageMagick 或 ffmpeg）", 501);
      await generateImageVariants(abs);
      invalidateVariantCache(m.url);
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
  // same bytes-new contract as the variant caches below: a URL memoized
  // `false` (file was missing) must re-stat once the bytes are back
  invalidateUploadExists(existing.url);
  // R555: the row update reads only the buffered bytes — it has NO dependency
  // on the variant cleanup — so the two run as one wave. The old shape made
  // the admin wait for three unlinks before the row reflected the new file.
  // Order inside the variant arm is preserved: the stale .wNNN files must be
  // gone BEFORE the regeneration is scheduled, or the generator would skip
  // widths whose files are the OLD picture's thumbnails.
  const [, [row]] = await Promise.all([
    (async () => {
      // the picture changed, so every cached variant of it is now wrong
      await removeVariants(abs);
      invalidateVariantCache(existing.url);
      if (/\.(jpe?g|png)$/i.test(abs)) scheduleVariantGeneration(abs, existing.url);
    })(),
    db
      .update(mediaTable)
      .set({
        mimeType: sniffMime(buffer) || mimeFor(existing.url) || existing.mimeType,
        size: buffer.length,
      })
      .where(eq(mediaTable.id, id))
      .returning(),
  ]);
  return row;
}

/**
 * Batched usage check - the shape the bulk delete path needs.
 *
 * Doing this per URL costs one full pass per table per URL, because the
 * content arm is a leading-wildcard match that no index can serve (pg_trgm is
 * not compiled into PGlite, so the LIKE has to read every row). Measured on a
 * 5 001-post fixture: 50 URLs as 50 individual checks = 1 141 ms, the same 50
 * as one literal-alternation regex = 84 ms, and the returned row set is
 * identical (diff empty both ways). One pass therefore costs what one check
 * costs instead of what N checks cost.
 *
 * The URLs go through inArray() as bound parameters and the pattern through a
 * bound text parameter, so nothing here is string-concatenated into SQL; every
 * metacharacter is escaped before it reaches the regex, otherwise a filename
 * like "a.b.png" would also match "axb.png".
 */
function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function countUsageForUrls(urls: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(urls.filter((u) => u))];
  for (const u of uniq) out.set(u, 0);
  if (!uniq.length) return out;
  const pat = `(${uniq.map(regexEscape).join("|")})`;
  const legs = await Promise.all([
    db
      .select({ feat: posts.featuredImage, body: sql<string | null>`${posts.content}::text` })
      .from(posts)
      .where(or(inArray(posts.featuredImage, uniq), sql`${posts.content}::text ~ ${pat}`)),
    db
      .select({ feat: pages.featuredImage, body: sql<string | null>`${pages.content}::text` })
      .from(pages)
      .where(or(inArray(pages.featuredImage, uniq), sql`${pages.content}::text ~ ${pat}`)),
  ]);
  for (const rows of legs) {
    for (const r of rows) {
      // One per row, matching what the single-URL check counts (rows, not
      // occurrences), so the two paths can never disagree about a count.
      for (const u of uniq) {
        if (r.feat === u || (r.body !== null && r.body.includes(u))) out.set(u, out.get(u)! + 1);
      }
    }
  }
  return out;
}

export async function deleteMediaMany(
  userIn: SessionUser | null,
  ids: number[],
  opts: { force?: boolean } = {},
): Promise<{
  deleted: number[];
  skipped: number[];
  referenced: Array<{ id: number; url: string; count: number }>;
}> {
  const user = requireUser(userIn);
  const deleted: number[] = [];
  const skipped: number[] = [];
  const referenced: Array<{ id: number; url: string; count: number }> = [];
  // The single-item panel asks /api/media/usage before its confirm; the bulk
  // path had no equivalent, so "delete 40 selected" removed files that articles
  // still pointed at and the admin found out from broken images. Guarded here,
  // where an API caller cannot walk around it.
  const block = new Set<number>();
  if (!opts.force && ids.length) {
    const rows = await db
      .select({ id: mediaTable.id, url: mediaTable.url })
      .from(mediaTable)
      .where(inArray(mediaTable.id, ids));
    const counts = await countUsageForUrls(rows.map((r) => r.url));
    for (const r of rows) {
      const c = counts.get(r.url) ?? 0;
      if (c > 0) {
        block.add(r.id);
        referenced.push({ id: r.id, url: r.url, count: c });
      }
    }
  }
  const targets = [...new Set(ids)].filter((id) => !block.has(id));
  if (targets.length) {
    const rows = await db
      .select()
      .from(mediaTable)
      .where(inArray(mediaTable.id, targets));
    const present = new Map(rows.map((r) => [r.id, r]));
    const outcomes = await Promise.all(
      targets.map(async (id) => {
        const row = present.get(id);
        if (!row) return { id, ok: false as const };
        try {
          canManage(user, row);
          await deleteFile(row.url).catch(() => {});
          const abs = uploadsAbsPath(row.url);
          if (abs && /\.(jpe?g|png)$/i.test(abs)) await removeVariants(abs);
          return { id, ok: true as const };
        } catch {
          return { id, ok: false as const };
        }
      }),
    );
    const cleaned = outcomes.filter((o) => o.ok).map((o) => o.id);
    if (cleaned.length) {
      await Promise.all([
        db.delete(mediaTable).where(inArray(mediaTable.id, cleaned)),
        ...cleaned.map((id) => recordAdminAction(user, "media.delete", { id })),
      ]);
    }
    for (const o of outcomes) (o.ok ? deleted : skipped).push(o.id);
  }
  // deleteMedia already logged one media.delete per row; this bulk line is the
  // "one selection, one intent" record an operator can actually search by.
  await recordAdminAction(user, "media.bulk_delete", { ids: deleted, skipped });
  return { deleted, skipped, referenced };
}
