// Local content storage — ported from lib/storage.ts's self-hosted branch.
import { promises as fs, statSync } from "fs";
import path from "path";
import zlib from "zlib";

export type UploadResult = {
  url: string;
  size: number;
  contentType: string;
};

export const CONTENT_DIR = path.join(process.cwd(), "content");
export const UPLOADS_DIR = path.join(CONTENT_DIR, "uploads");

// Absolute path of the static asset directory, resolved once. So probe the candidates once and cache the winner.
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
  // Nothing on disk (bare container, tests): keep the documented path so error
  // messages name the location a developer would look at.
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

// The real media type of a buffer, from its magic number. The signature is the only thing a client cannot talk its way past.
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
    // Order matters, and it is the reverse of the obvious one: the signature
    // first, then the extension table. mimeFor always answers (its fallback is
    // application/octet-stream), so this deliberately does NOT consult
    // File.type at all - the signature and the file's own name are the only two
    // inputs here that a client cannot set independently of the content.
    contentType: sniffMime(buffer) || mimeFor(localName),
  };
}

export async function deleteFile(url: string): Promise<void> {
  if (!url.startsWith("/uploads/")) return;
  const rel = decodeURIComponent(url.replace(/^\/uploads\//, ""));
  const target = path.resolve(UPLOADS_DIR, rel);
  // Never let a crafted URL escape the uploads root.
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

// Bound the memo like render.ts's variant/dimension caches: one entry per
// distinct image URL would otherwise accumulate for the life of the process
// (invalidated only when THAT image is uploaded/deleted). Evict oldest-first
// past the cap; a miss just re-stats the file.
const EXISTS_MEMO_CAP = 4000;

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
  if (existsMemo.size >= EXISTS_MEMO_CAP) {
    existsMemo.delete(existsMemo.keys().next().value as string);
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
 *
 * R268: same negotiation servePublic got in R267 — an uploaded .svg (or any
 * text upload) rode the wire raw. The compressed form is memoized per
 * file+mtime; uploads are written once, so the map stays small.
 */
const uploadsCompressed = new Map<string, { mtimeMs: number; br?: Buffer; gzip?: Buffer }>();

export async function serveUpload(urlPath: string, method = "GET", acceptEncoding: string | null = null): Promise<Response> {
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
    const st = await fs.stat(target);
    if (!st.isFile()) return notFound();
    const ext = path.extname(target).toLowerCase();
    // HEAD describes the same representation GET would send.
    const enc = pickPublicEncoding(acceptEncoding, ext);
    let data = await fs.readFile(target);
    let encoded = false;
    if (enc) {
      const memo = uploadsCompressed.get(target);
      const hit = memo && memo.mtimeMs === st.mtimeMs ? memo : null;
      const fresh = hit ?? { mtimeMs: st.mtimeMs };
      if (enc === "br") fresh.br ??= zlib.brotliCompressSync(data);
      else fresh.gzip ??= zlib.gzipSync(data);
      if (!hit) {
        if (uploadsCompressed.size > 4000) uploadsCompressed.clear();
        uploadsCompressed.set(target, fresh);
      }
      data = fresh[enc];
      encoded = true;
    }
    const headers: Record<string, string> = {
      "content-type": mimeFor(target),
      "content-length": String(data.length),
      "cache-control": "public, max-age=31536000, immutable",
      // Served straight from the app origin (user uploads / app assets):
      // nosniff stops a browser re-interpreting a mislabeled body as HTML/JS
      // (type-confusion XSS). Zero cost for correctly-typed content.
      "x-content-type-options": "nosniff",
    };
    if (encoded) headers["content-encoding"] = enc!;
    // The body is chosen by Accept-Encoding: a shared cache must know.
    headers["vary"] = "Accept-Encoding";
    // HEAD answers 200 with identical headers and no body (standard static
    // behavior; note a 204 Response with a body throws TypeError since 204
    // is a null-body status).
    return new Response(method === "HEAD" ? null : new Uint8Array(data), {
      status: 200,
      headers,
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
 *
 * R267: the handler was the delivery path but never negotiated compression —
 * the app middleware answers /public/** before the framework's (compressing)
 * file branch runs, so every admin.css / theme.css / vendor.js went over the
 * wire raw. Measured: 132 KB for theme.css. Compressible text types are now
 * brotli/gzip encoded per Accept-Encoding, memoized per file+mtime.
 */
const PUBLIC_COMPRESSIBLE = new Set([".css", ".js", ".mjs", ".json", ".svg", ".txt", ".csv", ".md", ".webmanifest"]);
const publicCompressed = new Map<string, { mtimeMs: number; br?: Buffer; gzip?: Buffer }>();

function pickPublicEncoding(acceptEncoding: string | null, ext: string): "br" | "gzip" | null {
  if (!PUBLIC_COMPRESSIBLE.has(ext)) return null;
  const ae = (acceptEncoding || "").toLowerCase();
  if (ae.includes("br")) return "br";
  if (ae.includes("gzip")) return "gzip";
  return null;
}

export async function servePublic(urlPath: string, method = "GET", acceptEncoding: string | null = null): Promise<Response> {
  const notFound = () =>
    new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  try {
    const rel = decodeURIComponent(urlPath.replace(/^\/public\//, ""));
    // Reject empty and traversal paths outright; resolve against PUBLIC_DIR and
    // require the result to stay inside it.
    if (!rel || rel.includes("\0")) return notFound();
    const root = path.resolve(PUBLIC_DIR);
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep) && target !== root) return notFound();
    const st = await fs.stat(target);
    if (!st.isFile()) return notFound();
    const ext = path.extname(target).toLowerCase();
    // HEAD describes the same representation GET would send (standard static
    // behavior), so the encoding is negotiated for both methods.
    const enc = pickPublicEncoding(acceptEncoding, ext);
    let data = await fs.readFile(target);
    let encoded = false;
    if (enc) {
      const memo = publicCompressed.get(target);
      const hit = memo && memo.mtimeMs === st.mtimeMs ? memo : null;
      const fresh = hit ?? { mtimeMs: st.mtimeMs };
      if (enc === "br") fresh.br ??= zlib.brotliCompressSync(data);
      else fresh.gzip ??= zlib.gzipSync(data);
      if (!hit) {
        // One entry per file; a rebuild changes mtime and this map cannot grow past the asset count.
        if (publicCompressed.size > 4000) publicCompressed.clear();
        publicCompressed.set(target, fresh);
      }
      data = fresh[enc];
      encoded = true;
    }
    const headers: Record<string, string> = {
      "content-type": mimeFor(target),
      // The compressed length; identity keeps the file size (RFC 9110: the
      // length must describe the bytes actually sent, not the uncompressed size).
      "content-length": String(data.length),
      "cache-control": "public, max-age=31536000, immutable",
      // Served straight from the app origin (user uploads / app assets):
      // nosniff stops a browser re-interpreting a mislabeled body as HTML/JS
      // (type-confusion XSS). Zero cost for correctly-typed content.
      "x-content-type-options": "nosniff",
    };
    if (encoded) headers["content-encoding"] = enc!;
    // The body is chosen by Accept-Encoding: a shared cache must know.
    headers["vary"] = "Accept-Encoding";
    return new Response(method === "HEAD" ? null : new Uint8Array(data), {
      status: 200,
      headers,
    });
  } catch {
    return notFound();
  }
}
