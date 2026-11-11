import zlib from "node:zlib";

/**
 * gzip a response body when the client asked for it and the body is worth it.
 *
 * The runtime compresses HTML and static files but not API bodies - it only
 * advertises `Vary: Accept-Encoding` - so a content export, the one API answer
 * that grows with the site, travelled raw (14 KB here, megabytes on a large
 * blog).
 *
 * It defaults the answer to `no-store` when the caller declared no policy of
 * its own. That is correct for a generated
 * download, and it is what keeps the encoded body out of the runtime's
 * response cache: a cached gzip body was later replayed to a client that did
 * not accept gzip, with no `content-encoding` header (measured: 3336-byte gzip
 * served as plain JSON). Callers that declare their own cache-control (the
 * immutable theme stylesheet) keep it.
 */
export async function gzipResponse(
  req: Request,
  res: Response,
  minBytes = 1024,
  encCache?: { br?: Buffer; gz?: Buffer } | null,
): Promise<Response> {
  const headers = new Headers(res.headers);
  if (res.headers.get("content-encoding")) return res;
  headers.set("vary", "Accept-Encoding");
  // An already-declared policy wins (the theme-style stylesheet is immutable);
  // the no-store default keeps a generated download out of response caches.
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  const accept = req.headers.get("accept-encoding") || "";
  if (!/\bgzip\b|\bbr\b/i.test(accept)) {
    return new Response(res.body, { status: res.status, headers });
  }
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length < minBytes) {
    return new Response(raw, { status: res.status, headers });
  }
  // encCache lets a caller with an immutable, content-addressed body pay the
  // compression once per body version instead of once per request (the theme
  // stylesheet: a sync br pass every hit would sit on the hot path).
  // br first: a ~78 KB stylesheet costs ~2.5x less than gzip at the same
  // latency (one sync compress on a memoized body, the server pays it once).
  const brHit = encCache?.br;
  if (/\bbr\b/i.test(accept)) {
    const br = brHit ?? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
    if (encCache && !brHit) encCache.br = br;
    headers.set("content-encoding", "br");
    headers.set("content-length", String(br.length));
    return new Response(new Uint8Array(br), { status: res.status, headers });
  }
  const gz = (encCache?.gz ?? zlib.gzipSync(raw, { level: 6 })) as Buffer;
  if (encCache && !encCache.gz) encCache.gz = gz;
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(gz.length));
  return new Response(new Uint8Array(gz), { status: res.status, headers });
}
