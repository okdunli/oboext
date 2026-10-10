/**
 * Local content storage — ported from lib/storage.ts's self-hosted branch.
 *
 * Uploads live in content/uploads/<folder>/<ts>-<rand><ext> (cwd-relative,
 * surviving builds) and are served at /uploads/... by _middleware.rose via
 * serveUpload(). The original's Vercel Blob branch is intentionally absent:
 * self-hosted Node is this project's deployment target (blob backends plug
 * in here later).
 */
import { promises as fs } from "fs";
import path from "path";

export type UploadResult = {
  url: string;
  size: number;
  contentType: string;
};

export const CONTENT_DIR = path.join(process.cwd(), "content");
export const UPLOADS_DIR = path.join(CONTENT_DIR, "uploads");

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
};

export function mimeFor(name: string, fallback = "application/octet-stream"): string {
  return EXT_MIME[path.extname(name).toLowerCase()] || fallback;
}

export async function uploadFile(file: File, folder = "media"): Promise<UploadResult> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = path.extname(file.name).toLowerCase().replace(/[^\w.]/g, "");
  const random = Math.random().toString(36).slice(2, 10);
  const localName = `${Date.now()}-${random}${ext}`;
  const dir = path.join(UPLOADS_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, localName), buffer);
  return {
    url: `/uploads/${folder}/${localName}`,
    size: buffer.length,
    contentType: file.type || mimeFor(localName),
  };
}

export async function deleteFile(url: string): Promise<void> {
  if (!url.startsWith("/uploads/")) return;
  const rel = decodeURIComponent(url.replace(/^\/uploads\//, ""));
  const target = path.resolve(UPLOADS_DIR, rel);
  if (!target.startsWith(path.resolve(UPLOADS_DIR))) return;
  await fs.unlink(target).catch(() => {});
}

/**
 * Serve /uploads/<rel> straight from content/uploads. Returns a 404 Response
 * for missing files or traversal attempts — never throws.
 */
export async function serveUpload(urlPath: string, method = "GET"): Promise<Response> {
  const notFound = () =>
    new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  try {
    const rel = decodeURIComponent(urlPath.replace(/^\/uploads\//, ""));
    const target = path.resolve(UPLOADS_DIR, rel);
    const root = path.resolve(UPLOADS_DIR);
    if (!target.startsWith(root + path.sep) && target !== root) return notFound();
    const data = await fs.readFile(target);
    return new Response(method === "HEAD" ? null : new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": mimeFor(target),
        "content-length": String(data.length),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return notFound();
  }
}
