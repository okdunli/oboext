/**
 * Local content storage — ported from lib/storage.ts's self-hosted branch.
 *
 * Uploads live in content/uploads/<folder>/<ts>-<rand><ext> (cwd-relative,
 * surviving builds) and are served at /uploads/... by _middleware.rose via
 * serveUpload(). The original's Vercel Blob branch is intentionally absent:
 * self-hosted Node is this project's deployment target (blob backends plug
 * in here later).
 */
import { promises as fs, statSync } from "fs";
import path from "path";

export type UploadResult = {
  url: string;
  size: number;
  contentType: string;
};

export const CONTENT_DIR = path.join(process.cwd(), "content");
export const UPLOADS_DIR = path.join(CONTENT_DIR, "uploads");

/**
 * Absolute path of the static asset directory, resolved once.
 *
 * In the repo the assets live at `oboext/public` — that is where the rosefd
 * compiler copies them and where tools/gen.mjs writes them. In a Vercel lambda
 * bundle they land at the top level as `public/`, because the compiler emits
 * them to `dist/public` and the bundle key is the path relative to `dist`.
 * Both layouts occur at runtime depending on how the process was started, and
 * hard-coding either one makes the other fail *silently*: a missing icon
 * directory yields an empty admin icon library, and a missing icon file yields
 * an empty inline `<svg>`, with no error anywhere.
 *
 * So probe the candidates once and cache the winner. `oboext/public` is checked
 * first because it is the source of truth for a local dev server.
 */
export const PUBLIC_DIR: string = (() => {
  const candidates = [
    path.join(process.cwd(), "oboext", "public"),
    path.join(process.cwd(), "public"),
  ];
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      /* try the next layout */
    }
  }
  return candidates[0];
})();

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
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
};

export function mimeFor(name: string, fallback = "application/octet-stream"): string {
  return EXT_MIME[path.extname(name).toLowerCase()] || fallback;
}

/**
 * The real media type of a buffer, from its magic number.
 *
 * `File.type` is whatever the browser decided to claim, and it is trivially
 * forged. It used to take priority over the extension table, so a `.png` that
 * was actually an HTML document got `image/png` recorded against it and was
 * then handed to the image resizer. The signature is the only thing a client
 * cannot talk its way past.
 *
 * Only types this codebase acts on are recognised; anything else returns null
 * and the caller falls back to the declared type. Refusing unknown files would
 * be a behaviour change well beyond this fix.
 */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (brand.startsWith("avif")) return "image/avif";
  }
  return null;
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
    contentType: sniffMime(buffer) || mimeFor(localName),
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
 * True when a stored image URL still resolves to a file on disk.
 *
 * A featured_image can outlive its file: a demo seed pointing at
 * /uploads/media/demo-01.png, a media record deleted from the panel while the
 * post kept the path, an upload lost with the container. The renderer used to
 * hand those URLs straight to <img>, so the browser 404'd and every
 * consumer of the image degraded - most visibly the share poster, whose
 * palette comes from sampling the cover and fell back to a black block.
 *
 * Remote URLs (http/data) and non-uploads paths are always kept: this only
 * answers "is the local file still there". The result is memoized per path
 * because a page render asks about the same cover many times.
 */
const existsMemo = new Map<string, boolean>();

export function uploadExists(url: string | null | undefined): boolean {
  if (!url) return false;
  if (!url.startsWith("/uploads/")) return true;
  const abs = uploadsAbsPath(url);
  if (!abs) return false;
  const hit = existsMemo.get(abs);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    ok = statSync(abs).isFile();
  } catch {
    ok = false;
  }
  existsMemo.set(abs, ok);
  return ok;
}

/** Drop the memoized existence check for a path (after an upload/ delete). */
export function invalidateUploadExists(url?: string): void {
  if (!url) {
    existsMemo.clear();
    return;
  }
  const abs = uploadsAbsPath(url);
  if (abs) existsMemo.delete(abs);
}

/**
 * F2e: the absolute disk path of an /uploads URL, or null for anything that
 * is not an uploads URL (remote images, data URIs) or escapes the root. The
 * responsive-variant pipeline (media.ts generation + render.ts srcset) uses
 * this to find the sibling `.wNNN` files beside an upload.
 */
export function uploadsAbsPath(url: string): string | null {
  if (!url.startsWith("/uploads/")) return null;
  try {
    const rel = decodeURIComponent(url.replace(/^\/uploads\//, ""));
    const target = path.resolve(UPLOADS_DIR, rel);
    const root = path.resolve(UPLOADS_DIR);
    if (!target.startsWith(root + path.sep) && target !== root) return null;
    return target;
  } catch {
    return null;
  }
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

/**
 * Serve /public/<rel> straight from PUBLIC_DIR.
 *
 * The app links its compiled assets as /public/** (admin.css, admin.js,
 * comments.js, icons/**, theme-*.js, vendor/**). The platform static layer is
 * generated from a deploy-root public/ mirror that does not reliably exist, so
 * this handler is the real delivery path: without it a request for
 * /public/admin.css falls through every middleware branch into page routing,
 * which 302s to /admin/login and the browser then trips the document CSP
 * trying to parse that HTML as a stylesheet.
 *
 * GET/HEAD only; traversal-protected; 404 (never a redirect) for anything
 * missing, so a stale asset link can never become a login redirect.
 */
export async function servePublic(urlPath: string, method = "GET"): Promise<Response> {
  const notFound = () =>
    new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  try {
    const rel = decodeURIComponent(urlPath.replace(/^\/public\//, ""));
    if (!rel || rel.includes("\0")) return notFound();
    const root = path.resolve(PUBLIC_DIR);
    const target = path.resolve(root, rel);
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
