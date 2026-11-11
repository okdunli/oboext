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

// Absolute path of the static asset directory, resolved once. So probe the
// candidates once and cache the winner.
// R459: dist/public joins the list. The framework's static layer already serves
// from there, but this handler is the FALLBACK for a flattened deploy whose
// cwd has neither oboext/public nor a root public mirror - without it the
// admin's /public/* requests 404 into the login redirect (unstyled admin).
export const PUBLIC_DIR: string = (() => {
  const candidates = [
    path.join(process.cwd(), "oboext", "public"),
    path.join(process.cwd(), "dist", "public"),
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
  ".xml": "application/xml; charset=utf-8",
  ".xsl": "text/xsl; charset=utf-8",
  ".xslt": "text/xsl; charset=utf-8",
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
  return uploadBuffer(Buffer.from(await file.arrayBuffer()), file.name, folder);
}

/**
 * The buffer-carrying core of uploadFile.
 *
 * R556: createMediaFromFile used to read `file.arrayBuffer()` for its own
 * magic-number sniff and then call uploadFile, which read the SAME array
 * buffer AGAIN for the write — two full copies of a file whose upload cap is
 * 25 MB. Callers that need the bytes (to sniff before accepting) pass them
 * in; the write and the stored size reuse the one buffer.
 */
export async function uploadBuffer(
  buffer: Buffer,
  originalName: string,
  folder = "media",
): Promise<UploadResult> {
  const ext = path.extname(originalName).toLowerCase().replace(/[^\w.]/g, "");
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
  // The existence memo keys on the same resolved path: dropping the entry
  // here is what keeps uploadExists from answering `true` for a file this
  // process just removed (a cover would keep rendering a dead image).
  existsMemo.delete(target);
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

/** Forget one URL's memo — a caller that rewrites the bytes behind an existing URL (media replace writes in place) must not keep the old answer. */
export function invalidateUploadExists(url: string): void {
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

type CompressedEntry = { mtimeMs: number; br?: Buffer; gzip?: Buffer };

/** Cap the compressed-body memo at CAP entries. Insertion-ordered Maps make
 *  delete+set an LRU touch; the oldest entry (first key) is evicted instead
 *  of dropping the whole cache - a clear() here used to throw away up to 4000
 *  brotli bodies (one big media file = one CPU-heavy resync) on the next
 *  request after a cold flush. */
const COMPRESSED_CAP = 4000;
function lruSet(map: Map<string, CompressedEntry>, key: string, entry: CompressedEntry): void {
  map.delete(key);
  while (map.size >= COMPRESSED_CAP) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, entry);
}

const uploadsCompressed = new Map<string, CompressedEntry>();

export async function serveUpload(
  urlPath: string,
  method = "GET",
  acceptEncoding: string | null = null,
  rangeHeader: string | null = null,
): Promise<Response> {
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
    // Media (audio/video) is seeked with Range requests; answering 200 with
    // the whole body breaks seeking (Safari refuses to play at all) and reads
    // the whole file into memory per request. Single byte range only - the
    // shape browsers send - and everything else keeps the full-body path.
    const rangeMatch =
      rangeHeader && /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (rangeMatch && method !== "HEAD") {
      let start = rangeMatch[1] === "" ? NaN : parseInt(rangeMatch[1], 10);
      let end = rangeMatch[2] === "" ? NaN : parseInt(rangeMatch[2], 10);
      if (Number.isNaN(start) && Number.isNaN(end)) return notFound();
      if (Number.isNaN(start)) {
        // suffix form: bytes=-N = the last N bytes
        start = Math.max(0, st.size - end!);
        end = st.size - 1;
      }
      if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${st.size}` },
        });
      }
      const fh = await fs.open(target, "r");
      try {
        const len = end - start + 1;
        const slice = Buffer.alloc(len);
        await fh.read(slice, 0, len, start);
        return new Response(new Uint8Array(slice), {
          status: 206,
          headers: {
            "content-type": mimeFor(target),
            "content-length": String(len),
            "content-range": `bytes ${start}-${end}/${st.size}`,
            "accept-ranges": "bytes",
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      } finally {
        await fh.close();
      }
    }
    // HEAD describes the same representation GET would send.
    const enc = pickPublicEncoding(acceptEncoding, ext);
    let data: Buffer = await fs.readFile(target);
    let encoded = false;
    if (enc) {
      const memo = uploadsCompressed.get(target);
      const hit = memo && memo.mtimeMs === st.mtimeMs ? memo : null;
      const fresh = hit ?? { mtimeMs: st.mtimeMs };
      if (enc === "br") fresh.br ??= zlib.brotliCompressSync(data);
      else fresh.gzip ??= zlib.gzipSync(data);
      if (!hit) {
        lruSet(uploadsCompressed, target, fresh);
      }
      data = fresh[enc] as Buffer;
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
      "accept-ranges": "bytes",
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
const PUBLIC_COMPRESSIBLE = new Set([".css", ".js", ".mjs", ".json", ".svg", ".txt", ".csv", ".md", ".webmanifest", ".xml", ".xsl", ".xslt"]);
const publicCompressed = new Map<string, CompressedEntry>();

function pickPublicEncoding(acceptEncoding: string | null, ext: string): "br" | "gzip" | null {
  if (!PUBLIC_COMPRESSIBLE.has(ext)) return null;
  const ae = (acceptEncoding || "").toLowerCase();
  if (ae.includes("br")) return "br";
  if (ae.includes("gzip")) return "gzip";
  return null;
}

export async function servePublic(urlPath: string, method = "GET", acceptEncoding: string | null = null, versioned = false): Promise<Response> {
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
    let data: Buffer = await fs.readFile(target);
    let encoded = false;
    if (enc) {
      const memo = publicCompressed.get(target);
      const hit = memo && memo.mtimeMs === st.mtimeMs ? memo : null;
      const fresh = hit ?? { mtimeMs: st.mtimeMs };
      if (enc === "br") fresh.br ??= zlib.brotliCompressSync(data);
      else fresh.gzip ??= zlib.gzipSync(data);
      if (!hit) {
        // One entry per file; a rebuild changes mtime and this map cannot grow past the asset count.
        lruSet(publicCompressed, target, fresh);
      }
      data = fresh[enc] as Buffer;
      encoded = true;
    }
    const headers: Record<string, string> = {
      "content-type": mimeFor(target),
      // The compressed length; identity keeps the file size (RFC 9110: the
      // length must describe the bytes actually sent, not the uncompressed size).
      "content-length": String(data.length),
      // Immutable is only honest for a content-addressed URL (?v=): an
      // unversioned /public/admin.css would otherwise stay stale in the
      // browser for a year after the deploy that changed it.
      "cache-control": versioned
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
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
