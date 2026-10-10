// Rose Frame Driver CLI - simplest possible SSR + static server

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';
import { buildProject, scanRoseFiles, scanComponentFiles, scriptOf, extractExports, loadPlugins, type RouteInfo } from '../compiler/index.js';
import { getHtmlShell, getClientSource, getStyles, shellOpen, clientScriptTag, securityHeaders, mintNonce, setBundleMode } from './shell.js';
import type * as ts from 'typescript';

type Encoding = 'br' | 'gzip' | 'deflate';

function pickEncoding(req: any): Encoding | null {
  const ae: string = req.headers['accept-encoding'] || '';
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  if (ae.includes('deflate')) return 'deflate';
  return null;
}

const brotliFast = { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 };

function compress(enc: Encoding, data: string | Buffer): Buffer {
  if (enc === 'br') return zlib.brotliCompressSync(data, { params: brotliFast });
  if (enc === 'gzip') return zlib.gzipSync(data);
  return zlib.deflateSync(data);
}

function createCompressor(enc: Encoding): zlib.Gzip | zlib.Deflate | zlib.BrotliCompress {
  if (enc === 'br') return zlib.createBrotliCompress({ params: brotliFast });
  if (enc === 'gzip') return zlib.createGzip();
  return zlib.createDeflate();
}

/** Send a full HTML document, compressed when the client accepts it. */
function sendHtml(req: any, res: any, status: number, html: string, extraHeaders?: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  let hash = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    hash ^= html.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  const etag = `W/"${html.length}-${hash.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.setHeader('ETag', etag);
  const enc = pickEncoding(req);
  if (enc) {
    res.setHeader('Content-Encoding', enc);
    res.end(compress(enc, html));
  } else {
    res.end(html);
  }
}

function writeWebHeaders(web: any, res: any): void {
  const cookies = web.headers.getSetCookie?.() ?? [];
  web.headers.forEach((v: string, k: string) => {
    if (cookies.length && k.toLowerCase() === 'set-cookie') return;
    res.setHeader(k, v);
  });
  if (cookies.length) res.setHeader('set-cookie', cookies);
}

async function sendWebResponse(web: any, res: any): Promise<void> {
  writeWebHeaders(web, res);
  res.statusCode = web.status;
  res.end(Buffer.from(await web.arrayBuffer()));
}

// Send a rendered page document - through onResponse first .
async function sendPage(req: any, res: any, ssrModule: any, hookCtx: any, page: any, routePath: string): Promise<void> {
  let status = page.status ?? 200;
  const nonce = nonceFor(ssrModule, routePath);
  let html = getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir, nonce);
  let headers: Record<string, any> = pageHeaders(ssrModule, routePath, nonce);
  if (hookCtx) {
    const out = await ssrModule.runResponseHooks(hookCtx, new Response(html, { status, headers }));
    status = out.status;
    headers = webHeadersToNode(out);
    html = await out.text();
  }
  sendHtml(req, res, status, html, headers);
}

const fileCache = new Map<string, { mtimeMs: number; raw: Buffer; br: Buffer; gzip: Buffer; etag: string }>();

const SRC_DIR = process.argv[3] ? path.resolve(process.argv[3]) : process.cwd();
const OUT_DIR = path.join(process.cwd(), 'dist');
const PORT = Number(process.env.PORT) || 3000;

// Import dist/server.js, cached until the file changes on disk.
let serverModule: any = null;
let serverMtime = -1;
let serverVersion = 0;

async function loadServer(): Promise<any> {
  const file = path.join(OUT_DIR, 'server.js');
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (!serverModule || mtimeMs !== serverMtime) {
    serverMtime = mtimeMs;
    serverVersion++;
    serverModule = await import(pathToFileURL(file).href + '?v=' + serverVersion);
  }
  return serverModule;
}

async function build(): Promise<void> {
  const { routes, bundle } = await buildProject(SRC_DIR, OUT_DIR);
  await clearPrerendered(OUT_DIR);
  setBundleMode(bundle);
  const skipped = await prerender(routes);
  await fs.promises.writeFile(path.join(OUT_DIR, 'broken.json'), JSON.stringify(skipped));
  const ssrModule = await loadServer();
  await fs.promises.writeFile(path.join(OUT_DIR, 'headers.json'), JSON.stringify({
    default: securityHeaders(getClientSource()),
    routes: ssrModule.routeHeaders ?? [],
  }));
  await writeBrotli(OUT_DIR);
}

// Write dist/<file>.br next to every compressible text file.
const BROTLI_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);
async function writeBrotli(dir: string): Promise<void> {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await writeBrotli(p);
      continue;
    }
    if (!BROTLI_EXT.has(path.extname(e.name).toLowerCase())) continue;
    await fs.promises.writeFile(p + '.br', zlib.brotliCompressSync(await fs.promises.readFile(p)));
  }
}

// Delete the prerendered output of a previous build: HTML documents and baked API bodies, with their brotli siblings.
async function clearPrerendered(dir: string, depth = 0): Promise<void> {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (depth === 0 && e.name === 'locales' && e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await clearPrerendered(p, depth + 1);
      continue;
    }
    if (!/\.(?:html|json)(?:\.br)?$/.test(e.name)) continue;
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rm(p, { force: true });
        break;
      } catch (err) {
        if (attempt >= 2 || !/EPERM|EBUSY|EACCES/.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  }
}

// Prerender every static route to dist/<route>/index.html at build time.
async function prerender(routes: RouteInfo[]): Promise<string[]> {
  const ssrModule = await loadServer();
  const skipped: string[] = [];
  const write = async (routePath: string) => {
    const mw = await ssrModule.runMiddleware({ method: 'GET', url: routePath, headers: {} });
    if (mw) {
      console.error(`prerender skipped for ${routePath}: the middleware short-circuits at build time`);
      skipped.push(routePath);
      return;
    }
    const page = await ssrModule.renderPage(routePath);
    if (page.status === 500) {
      console.error(`prerender skipped for ${routePath}: render failed, the error page rendered`);
      skipped.push(routePath);
      return;
    }
    const routeDir = routePath === '/' ? OUT_DIR : path.join(OUT_DIR, routePath.slice(1));
    await fs.promises.mkdir(routeDir, { recursive: true });
    await fs.promises.writeFile(path.join(routeDir, 'index.html'), getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir));
    console.log(`prerendered ${routePath} -> ${path.relative(process.cwd(), path.join(routeDir, 'index.html'))}`);
  };

  for (const info of routes) {
    if ((ssrModule.dynamicRoutes as string[]).includes(info.routePath)) {
      console.log(`dynamic route ${info.routePath}: per-request state (getContext/$store), rendered on demand`);
      continue;
    }
    if (info.paramNames.length === 0) {
      try {
        await write(info.routePath);
      } catch (err) {
        console.error(`prerender skipped for ${info.routePath}: ${err instanceof Error ? err.message : err}`);
        skipped.push(info.routePath);
      }
      continue;
    }
    try {
      const paramsExport = (ssrModule.routeParams as Record<string, unknown>)?.[info.routePath];
      const raw = typeof paramsExport === 'function' ? await (paramsExport as () => unknown)() : paramsExport;
      const paths = enumerateParams(info.pattern, info.paramNames, (raw ?? {}) as Record<string, unknown>);
      for (const p of paths) await write(p);
      if (paths.length === 0) console.log(`dynamic route ${info.routePath}: no params export, rendered on demand`);
    } catch (err) {
      console.error(`prerender skipped for ${info.routePath}: ${err instanceof Error ? err.message : err}`);
      skipped.push(info.routePath);
    }
  }

  const apiPrerender = (ssrModule.apiPrerender as Record<string, boolean>) ?? {};
  for (const [routePath, on] of Object.entries(apiPrerender)) {
    if (!on) continue;
    try {
      const res = await ssrModule.handleApi('GET', routePath, new Request('http://localhost' + routePath));
      if (res.status !== 200) {
        console.error(`api prerender skipped for ${routePath}: GET answered ${res.status}`);
        continue;
      }
      const body = await res.text();
      const outFile = path.join(OUT_DIR, routePath.slice(1) + '.json');
      await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
      await fs.promises.writeFile(outFile, body);
      console.log(`prerendered api ${routePath} -> ${path.relative(process.cwd(), outFile)}`);
    } catch (err) {
      console.error(`api prerender skipped for ${routePath}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return skipped;
}

/** Cartesian product of the params map -> concrete URL paths for the pattern. */
function enumerateParams(pattern: string, names: string[], raw: Record<string, unknown>): string[] {
  let combos: string[][] = [[]];
  for (const name of names) {
    const values = (Array.isArray(raw[name]) ? raw[name] : []).map((v) => String(v));
    combos = combos.flatMap((c) => values.map((v) => [...c, v]));
  }
  return combos.map((values) => {
    let i = 0;
    return pattern
      .split('/')
      .map((seg) => (seg.startsWith(':') ? encodeURIComponent(values[i++]) : seg))
      .join('/');
  });
}

const ASSET_EXT = new Set(['.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.txt', '.xml']);

function pageHeaders(ssrModule: any, pathname: string, nonce = ''): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(securityHeaders(getClientSource(), nonce))) headers[k.toLowerCase()] = v;
  const own = ssrModule.headersFor?.(pathname) as Record<string, string> | null | undefined;
  if (own) for (const [k, v] of Object.entries(own)) headers[k.toLowerCase()] = v;
  return headers;
}

/**
 * The nonce for one response, or '' when the route keeps the hashed policy
 * . Only the routes that exported `csp = { nonce: true }` ask for one,
 * so every other document is byte-for-byte what it was.
 */
function nonceFor(ssrModule: any, pathname: string): string {
  return ssrModule.cspNonce?.(pathname) ? mintNonce() : '';
}

const isrBusy = new Set<string>();
function revalidateInBackground(routePath: string, filePath: string): void {
  if (isrBusy.has(filePath)) return;
  isrBusy.add(filePath);
  void (async () => {
    try {
      const ssrModule = await loadServer();
      const page = await ssrModule.renderPage(routePath);
      if (page.status === 200) {
        await fs.promises.writeFile(filePath, getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir));
        fileCache.delete(filePath);
        console.log(`Rose Frame Driver: revalidated ${routePath} in the background`);
      }
    } catch (err) {
      console.error('Rose Frame Driver: background revalidation failed for', routePath, err instanceof Error ? err.message : err);
    } finally {
      isrBusy.delete(filePath);
    }
  })();
}

/** A request body is bounded. 1 MB holds any form and any JSON API call a
 * site this size makes; a deployment that needs more sets it explicitly. */
const MAX_BODY = Number(process.env.ROSEFD_MAX_BODY) || 1024 * 1024;

/**
 * Collect a request body, refusing anything past MAX_BODY with a 413. The
 * refusal stops buffering immediately, so a client streaming 10 GB gets one
 * small response instead of a 10 GB buffer.
 */
function readBody(req: any, res: any, onDone: (body: any) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  req.on('data', (c: Buffer) => {
    if (refused) return;
    size += c.length;
    if (size > MAX_BODY) {
      refused = true;
      res.statusCode = 413;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Payload too large (limit ${MAX_BODY} bytes)`);
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!refused) onDone(Buffer.concat(chunks)); });
  req.on('error', () => {});
}

/**
 * CSRF: a state-changing request that did not come from this site is
 * refused before anything else runs. Browsers stamp every cross-origin POST
 * with an Origin header, so the check is free for real browsers; a client
 * that sends neither Origin nor Sec-Fetch-Site (curl, a health check, the
 * test suites) is not attackable by CSRF - the attack rides the victim's
 * cookies in a browser - so it passes. Returns the refusal, or null.
 */
function crossSiteWrite(req: any): { status: number; body: string } | null {
  const m = req.method;
  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH' && m !== 'DELETE') return null;
  const origin = req.headers.origin;
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return { status: 403, body: 'Cross-site request blocked (unparsable Origin header)' };
    }
    return host === req.headers.host ? null : { status: 403, body: 'Cross-site request blocked (Origin does not match Host)' };
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return { status: 403, body: `Cross-site request blocked (sec-fetch-site: ${site})` };
  }
  return null;
}

/**
 * One access line per request on stdout - the same greppable shape the Go
 * binary writes (`ts method path status bytes duration`), with the worker id
 * in front when several workers share one stdout. Logged on the response's
 * finish, so a streamed route is recorded when it is actually done.
 */
function withAccessLog(handler: (req: any, res: any) => void, tag?: string): (req: any, res: any) => void {
  return (req, res) => {
    const started = process.hrtime.bigint();
    let bytes = 0;
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk: any, ...rest: any[]) => { if (chunk) bytes += Buffer.byteLength(chunk); return write(chunk, ...rest); };
    res.end = (chunk: any, ...rest: any[]) => { if (chunk) bytes += Buffer.byteLength(chunk); return end(chunk, ...rest); };
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const dur = ms >= 1 ? `${ms.toFixed(3)}ms` : `${(ms * 1000).toFixed(0)}us`;
      console.log(`${new Date().toISOString().slice(0, 19)}Z${tag ? ` [${tag}]` : ''} ${req.method} ${req.url} ${res.statusCode} ${bytes}B ${dur}`);
    });
    handler(req, res);
  };
}

/**
 * The context a runtime plugin hook receives. Node's
 * IncomingMessage is not a Web Request and a hook must not care which server
 * it runs on, so the CLI builds the same object the edge adapter already
 * has. Built only when the project declares a runtime hook (the server
 * bundle exports the flags) - the hot path never pays for the feature.
 *
 * The body is deliberately not attached: the servers read it lazily, and
 * buffering it for every request would cost the fast path. A hook that needs
 * the submitted form uses pages/_middleware.rose, which already rides with
 * the parsed FormData.
 */
async function hookContext(req: any): Promise<{
  request: Request;
  url: URL;
  method: string;
  pathname: string;
  state: Record<string, unknown>;
}> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
    method: req.method || 'GET',
    headers,
  });
  const url = new URL(request.url);
  return { request, url, method: request.method, pathname: url.pathname, state: {} };
}

/** A Web Response's headers as a Node header record, set-cookie kept whole. */
function webHeadersToNode(web: any): Record<string, any> {
  const out: Record<string, any> = {};
  const cookies = web.headers.getSetCookie?.() ?? [];
  web.headers.forEach((v: string, k: string) => {
    if (cookies.length && k.toLowerCase() === 'set-cookie') return;
    out[k] = v;
  });
  if (cookies.length) out['set-cookie'] = cookies;
  return out;
}

function serveStatic(dir: string, isr = false): (req: any, res: any) => void {
  return (req, res) => {
    const blocked = crossSiteWrite(req);
    if (blocked) {
      res.statusCode = blocked.status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(blocked.body);
      return;
    }
    loadServer().then(async (ssrModule: any) => {
      const hookCtx = ssrModule.hasRequestHooks === true || ssrModule.hasResponseHooks === true
        ? await hookContext(req)
        : null;
      if (hookCtx) {
        const short = await ssrModule.runRequestHooks(hookCtx);
        if (short) {
          await sendWebResponse(await ssrModule.runResponseHooks(hookCtx, short), res);
          return;
        }
      }
      const apiPath0 = pathnameOf(req.url);
      const isPagePost = req.method === 'POST' && !ssrModule.isApi(apiPath0);
      if (!isPagePost && ssrModule.middleware) {
        const mw = await ssrModule.runMiddleware(req);
        if (mw) {
          await sendWebResponse(hookCtx ? await ssrModule.runResponseHooks(hookCtx, mw) : mw, res);
          return;
        }
      }
      const apiPath = pathnameOf(req.url);
      if (ssrModule.isApi(apiPath)) {
        readBody(req, res, async (body) => {
          try {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) {
              if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
            }
            const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
              method: req.method || 'GET',
              headers,
              body: body.length > 0 ? body : undefined,
            });
            let apiRes = await ssrModule.handleApi(req.method || 'GET', apiPath, request);
            if (hookCtx) apiRes = await ssrModule.runResponseHooks(hookCtx, apiRes);
            writeWebHeaders(apiRes, res);
            res.statusCode = apiRes.status;
            res.end(Buffer.from(await apiRes.arrayBuffer()));
          } catch {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end('{"error":"api handler failed"}');
          }
        });
        return;
      }

      if (req.method === 'POST') {
        readBody(req, res, async (body) => {
          try {
            const form = await new Response(body, {
              headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded' },
            }).formData();
            if (ssrModule.middleware) {
              const mw = await ssrModule.runMiddleware(req, form);
              if (mw) {
                await sendWebResponse(hookCtx ? await ssrModule.runResponseHooks(hookCtx, mw) : mw, res);
                return;
              }
            }
            const page = await ssrModule.renderPage(req.url || '/', form);
            await sendPage(req, res, ssrModule, hookCtx, page, pathnameOf(req.url || '/'));
          } catch {
            res.statusCode = 400;
            res.end('Bad request');
          }
        });
        return;
      }

      let safe = path.normalize(req.url || '/').replace(/^(\.\.(\/)?)+/, '');
      if (safe === '\\' || safe === '/') safe = '/';
      let filePath = path.join(dir, safe);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (/\.(?:br|gz)$/i.test(safe)) {
        const base = filePath.replace(/\.(?:br|gz)$/i, '');
        if (fs.existsSync(base)) filePath = base;
      }

      const isAsset = ASSET_EXT.has(path.extname(safe).toLowerCase());
      const isDynamic = !isAsset && (ssrModule.dynamicRoutes as string[] | undefined)?.includes(pathnameOf(req.url));
      if (!isDynamic && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const st = fs.statSync(filePath);
        const rev = isAsset ? undefined : ((ssrModule.revalidate as { pattern: string; seconds: number }[]) || [])
          .find((r) => ssrModule.matchRoute(r.pattern, pathnameOf(req.url)));
        if (isr && rev && Date.now() - st.mtimeMs > rev.seconds * 1000) {
          revalidateInBackground(pathnameOf(req.url), filePath);
        }
        let entry = fileCache.get(filePath);
        if (!entry || entry.mtimeMs !== st.mtimeMs) {
          const raw = fs.readFileSync(filePath);
          entry = {
            mtimeMs: st.mtimeMs,
            raw,
            br: zlib.brotliCompressSync(raw),
            gzip: zlib.gzipSync(raw, { level: 9 }),
            etag: `W/"${st.size}-${st.mtimeMs}"`,
          };
          fileCache.set(filePath, entry);
        }
        const ext = path.extname(filePath);
        const types: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
        };
        const fileHeaders: Record<string, string> = {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Cache-Control': rev ? `public, max-age=0, stale-while-revalidate=${rev.seconds}` : 'public, max-age=3600',
          'ETag': entry.etag,
          'Vary': 'Accept-Encoding',
        };
        if (ext === '.html') Object.assign(fileHeaders, pageHeaders(ssrModule, pathnameOf(req.url)));
        let status = 200;
        if (hookCtx) {
          const out = await ssrModule.runResponseHooks(hookCtx, new Response(null, { status, headers: fileHeaders }));
          status = out.status;
          for (const [k, v] of Object.entries(webHeadersToNode(out))) res.setHeader(k, v);
        } else {
          for (const [k, v] of Object.entries(fileHeaders)) res.setHeader(k, v);
        }
        if (req.headers['if-none-match'] === entry.etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        const enc = pickEncoding(req);
        res.statusCode = status;
        if (enc) {
          res.setHeader('Content-Encoding', enc);
          res.end(enc === 'br' ? entry.br : enc === 'gzip' ? entry.gzip : compress('deflate', entry.raw));
        } else {
          res.end(entry.raw);
        }
        return;
      }

      let broken = new Set<string>();
      try {
        broken = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'broken.json'), 'utf-8')));
      } catch { /* no manifest: nothing known-broken */ }
      const safe2 = req.url || '/';
      if (!broken.has(safe2) && ssrModule.canStream(safe2) && !ssrModule.isNoJs(safe2)) {
        const enc = pickEncoding(req);
        let status = 200;
        const nonce = nonceFor(ssrModule, pathnameOf(safe2));
        let headers: Record<string, any> = pageHeaders(ssrModule, pathnameOf(safe2), nonce);
        if (hookCtx) {
          const out = await ssrModule.runResponseHooks(hookCtx, new Response(null, { status, headers }));
          status = out.status;
          headers = webHeadersToNode(out);
        }
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Vary', 'Accept-Encoding');
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        let write: (chunk: string) => void;
        let done: () => void;
        if (enc) {
          res.setHeader('Content-Encoding', enc);
          const compressor = createCompressor(enc);
          compressor.pipe(res);
          let flushed = false;
          write = (chunk) => {
            compressor.write(chunk);
            if (!flushed) {
              flushed = true;
              compressor.flush(zlib.constants.Z_FULL_FLUSH);
            }
          };
          compressor.on('error', () => res.destroy());
          done = () => compressor.end();
        } else {
          write = (chunk) => res.write(chunk);
          done = () => res.end();
        }
        const doc = ssrModule.docAttrs(safe2);
        await ssrModule.renderPageStream(safe2, write, shellOpen(getStyles(), doc.lang, doc.dir), clientScriptTag(getClientSource(), nonce));
        done();
        return;
      }
      const page = await ssrModule.renderPage(safe2);
      await sendPage(req, res, ssrModule, hookCtx, page, pathnameOf(safe2));
    }).catch(() => {
      res.statusCode = 404;
      res.end('Not found');
    });
  };
}

/** Strip the query string: routing matches the pathname, handlers read the full URL. */
function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url || '/', 'http://localhost').pathname;
  } catch {
    return (url || '/').split('?')[0];
  }
}

/**
 * The version from package.json - one source of truth, no constant to drift.
 * Resolved from THIS module (not the cwd): the banner names the framework's
 * version even when it builds somebody else's project. Two layouts answer:
 * in the repo this module sits at src/cli/, in the published package the CLI
 * is bundled to dist-cli/ with the sources beside it - so try both.
 */
function version(): string {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')).version;
      if (v) return v;
    } catch { /* not this layout */ }
  }
  return '0.0.0';
}

async function dev(): Promise<void> {
  console.log(`🌹 Rose Frame Driver v${version()} dev server starting...`);
  try {
    await build();
  } catch (err) {
    console.error('Initial build failed (server still running):', err instanceof Error ? err.message : err);
  }

  let timeout: any;
  fs.watch(SRC_DIR, { recursive: true }, () => {
    clearTimeout(timeout);
    timeout = setTimeout(async () => {
      try {
        console.log('Rebuilding...');
        await build();
      } catch (err) {
        console.error('Build failed (server still running):', err instanceof Error ? err.message : err);
      }
    }, 200);
  });

  const http = await import('http');
  const server = http.createServer(serveStatic(OUT_DIR));

  server.listen(PORT, () => {
    console.log('🌹 http://localhost:' + PORT);
  });
}

async function preview(): Promise<void> {
  await build();
  const http = await import('http');
  const server = http.createServer(serveStatic(OUT_DIR, true));

  server.listen(PORT, () => {
    console.log(`🌹 Rose Frame Driver v${version()} preview at http://localhost:` + PORT);
  });
}

// `rosefd serve` runs what `build` produced - no rebuild, no watcher.
async function serve(): Promise<void> {
  if (!fs.existsSync(path.join(OUT_DIR, 'server.js'))) {
    console.error(`Rose Frame Driver: ${OUT_DIR} has no server.js - run rosefd build first`);
    process.exit(1);
  }
  const cluster = (await import('node:cluster')).default as any;
  cluster.schedulingPolicy = cluster.SCHED_RR;
  const os = await import('node:os');
  const workers = Math.max(1, Number(process.env.ROSEFD_WORKERS) || os.cpus().length);
  const PORT = Number(process.env.PORT) || 3000;
  if (cluster.isPrimary) {
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on('message', (worker: any, msg: any) => {
      if (!msg || msg.type !== 'rosefd:store') return;
      for (const w of Object.values<any>(cluster.workers ?? {})) {
        if (w && w.id !== worker.id) w.send(msg);
      }
    });
    let live = workers;
    const stop = () => {
      for (const w of Object.values<any>(cluster.workers ?? {})) w.kill();
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    cluster.on('exit', () => { if (--live <= 0) process.exit(0); });
    console.log(`🌹 Rose Frame Driver v${version()} serve: ${workers} worker${workers > 1 ? 's' : ''} on http://localhost:${PORT} (cluster, bounded bodies, graceful shutdown, access log on stdout)`);
    return;
  }
  process.on('disconnect', () => process.exit(0));
  let servicePlugins: any[] = [];
  try {
    servicePlugins = (await loadPlugins(SRC_DIR)).filter((p) => p && p.onServe);
  } catch (err) {
    console.error('Rose Frame Driver: rosefd.config.js failed to load for the serve hooks:', err instanceof Error ? err.message : err);
  }
  const http = await import('node:http');
  const server = http.createServer(withAccessLog(serveStatic(OUT_DIR, true), `w${process.pid}`));
  server.requestTimeout = 30_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, async () => {
    console.log(`🌹 Rose Frame Driver worker ${process.pid} listening on http://localhost:${PORT}`);
    for (const p of servicePlugins) {
      try {
        await p.onServe({ port: PORT, workers });
      } catch (err) {
        console.error('Rose Frame Driver: plugin', p.name, 'onServe failed:', err instanceof Error ? err.message : err);
      }
    }
  });
  const stop = () => {
    for (const p of servicePlugins) {
      if (!p.onShutdown) continue;
      try {
        void Promise.resolve(p.onShutdown()).catch((err: unknown) => {
          console.error('Rose Frame Driver: plugin', p.name, 'onShutdown failed:', err instanceof Error ? err.message : err);
        });
      } catch (err) {
        console.error('Rose Frame Driver: plugin', p.name, 'onShutdown failed:', err instanceof Error ? err.message : err);
      }
    }
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// `rosefd new <name>` - a starting project.
async function scaffold(): Promise<void> {
  const name = process.argv[3];
  if (!name || name.startsWith('-')) {
    console.log('Usage: rosefd new <name>   (creates <name>/ with a page that builds)');
    return;
  }
  const dir = path.resolve(name);
  if (fs.existsSync(dir)) {
    console.error(`Rose Frame Driver: ${dir} already exists - pick another name`);
    process.exit(1);
  }
  const pages = path.join(dir, 'src', 'pages');
  fs.mkdirSync(pages, { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: path.basename(dir),
    private: true,
    type: 'module',
    scripts: {
      dev: 'rosefd dev',
      build: 'rosefd build',
      preview: 'rosefd preview',
      serve: 'rosefd serve',
      check: 'rosefd check',
    },
    dependencies: { rosefd: `^${version()}` },
    devDependencies: { typescript: '^5.6.0' },
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(dir, 'rosefd-env.d.ts'), `/// <reference types="rosefd" />\n`);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['rosefd-env.d.ts', 'src/**/*.ts'],
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(pages, 'index.rose'), `<script>
  // One file per route: markup, script and styles together.
  // The script block is TypeScript - interfaces, annotations, generics and
  // casts all compile, and \`npm run check\` type-checks them.
  interface Item { label: string }

  let count = $state(0);
  let items = $state<string[]>(['zero hydration', 'one request', 'no build config']);
  let showList = $state(true);

  function increment() { $setState('count', count() + 1); }
  function toggleList() { $setState('showList', !showList()); }
  // typed server data: the body runs per request on the server (and ships
  // to the client, where it re-runs on a client-side navigation)
  let first: Item = $data((): Item => ({ label: items()[0] ?? 'nothing yet' }));
</script>

<h1>🌹 Rose Frame Driver</h1>
<p>Count: <strong>{count()}</strong> - first item: {first().label}</p>
<button on:click={increment}>Increment</button>
<button on:click={toggleList}>{showList() ? 'Hide' : 'Show'} the list</button>

{#if showList()}
<ul>
  {#each items() as item}
    <li>{item}</li>
  {/each}
</ul>
{/if}

<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  button { padding: 0.5rem 1rem; margin-right: 0.5rem; }
</style>
`);

  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}

A Rose Frame Driver project. One file per route in \`src/pages/\`.

\`\`\`bash
npm install     # pulls the rosefd package (and typescript, for checking)
npm run dev     # dev server with hot rebuild: http://localhost:3000
npm run build   # compiles to dist/
npm run serve   # production runner (cluster, access log, graceful shutdown)
npm run check   # type-checks every .rose script
\`\`\`

Add a route by adding a file: \`src/pages/about.rose\` serves \`/about\`.
\`src/pages/_layout.rose\` wraps every route, \`src/pages/_middleware.rose\`
runs before every request, \`src/pages/api/*.rose\` answers JSON.
`);

  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n');

  console.log(`🌹 Created ${dir}`);
  console.log(`   src/pages/index.rose  - a typed page that builds and runs`);
  console.log(`   rosefd-env.d.ts + tsconfig.json - the script globals, typed`);
  console.log(`\n   cd ${name}`);
  console.log(`   npm install && npm run dev`);
  console.log(`   npm run check    # type-checks every .rose script`);
}

/**
 * `rosefd check [dir]` - type-check every .rose script with the
 * PROJECT's own TypeScript.
 *
 * esbuild strips types without checking them, so a wrong argument type or a
 * typo in an interface is invisible at build time: the build succeeds and the
 * bug ships. This closes that hole - it extracts the exact block the compiler
 * embeds (scriptOf, one regex, one truth), pads it so line and column numbers
 * still point at the .rose file, and runs the project's TypeScript over all
 * of them in one program, with rosefd's own globals in scope.
 *
 * No TypeScript in the project is a hard error: a check that cannot run must
 * never pass silently. trade-off: no temp files, no tsconfig parsing - an
 * in-memory compiler host and fixed strict options, documented.
 */
async function check(): Promise<void> {
  const files = [...(await scanRoseFiles(SRC_DIR)), ...(await scanComponentFiles(SRC_DIR))];
  if (files.length === 0) {
    console.error(`Rose Frame Driver: no .rose pages found under ${path.join(SRC_DIR, 'src', 'pages')} - run rosefd check from a project root, or pass one: rosefd check <dir>`);
    process.exit(1);
  }

  let tsMod: typeof ts;
  try {
    const req = createRequire(pathToFileURL(path.join(SRC_DIR, 'package.json')));
    tsMod = await import(pathToFileURL(req.resolve('typescript')).href) as typeof ts;
  } catch {
    console.error(`Rose Frame Driver: type checking needs typescript in this project - npm i -D typescript`);
    process.exit(1);
  }

  const nextTo = (rel: string[]) => rel.map((r) => fileURLToPath(new URL(r, import.meta.url))).find((p) => fs.existsSync(p));
  const typesFile = nextTo(['../types/rosefd.d.ts', '../src/types/rosefd.d.ts']);
  if (!typesFile) {
    console.error('Rose Frame Driver: the type definitions (src/types/rosefd.d.ts) were not found next to the compiler');
    process.exit(1);
  }
  const runtimeSource = nextTo(['../runtime/index.ts', '../src/runtime/index.ts']);

  const norm = (f: string) => path.resolve(f).replace(/\\/g, '/');
  const virtual = new Map<string, string>();
  let checked = 0;
  for (const file of files) {
    const source = await fs.promises.readFile(file, 'utf-8');
    const m = /<script>/.exec(source);
    const script = scriptOf(source);
    if (!script) continue;
    const tagLine = source.slice(0, m!.index + '<script>'.length).split('\n').length;
    const wired = runtimeSource
      ? script.replace(/['"]\.\/runtime\.js['"]/g, JSON.stringify(runtimeSource.replace(/\\/g, '/')))
      : script;
    virtual.set(norm(file), '\n'.repeat(tagLine - 1) + wired);
    checked++;
  }
  if (checked === 0) {
    console.log('Rose Frame Driver: no .rose scripts to check');
    return;
  }

  const propType = (def: string | null): string => {
    if (!def) return 'unknown';
    if (/^['"`]/.test(def)) return 'string';
    if (/^-?\d+(\.\d+)?$/.test(def)) return 'number';
    if (/^(true|false)$/.test(def)) return 'boolean';
    return 'unknown';
  };
  const ROSE_IMPORT_RE = /['"](\.[^'"]+\.rose)['"]/g;
  const declared = new Set<string>();
  for (const file of [...virtual.keys()]) {
    const script = scriptOf(await fs.promises.readFile(file, 'utf-8').catch(() => ''));
    if (!script) continue;
    for (const spec of script.matchAll(ROSE_IMPORT_RE)) {
      const target = norm(path.resolve(path.dirname(file), spec[1]));
      if (target === file || declared.has(target)) continue;
      const targetSource = await fs.promises.readFile(target, 'utf-8').catch(() => null);
      if (targetSource === null) continue;
      const props = extractExports(scriptOf(targetSource) ?? '').props;
      virtual.set(`${target}.d.ts`, [
        `declare function render(closes: unknown[], children: string, __props: { ${props.map((p) => `${p.name}?: ${propType(p.def)}`).join('; ')} }, __slots?: Record<string, unknown>): string;`,
        'export default render;',
        '',
      ].join('\n'));
      declared.add(target);
    }
  }

  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: tsMod.ScriptTarget.ES2022,
    module: tsMod.ModuleKind.ESNext,
    moduleResolution: tsMod.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  };
  const host = tsMod.createCompilerHost(options);
  host.getCurrentDirectory = () => path.resolve(SRC_DIR);
  const realRead = host.readFile.bind(host);
  const realGet = host.getSourceFile.bind(host);
  host.readFile = (f) => virtual.get(norm(f)) ?? realRead(f);
  host.fileExists = (f) => virtual.has(norm(f)) || tsMod.sys.fileExists(f);
  host.getSourceFile = (f, version, onError, shouldCreate) => {
    const src = virtual.get(norm(f));
    return src ? tsMod.createSourceFile(f, src, version, true) : realGet(f, version, onError, shouldCreate);
  };

  const program = tsMod.createProgram([...virtual.keys(), typesFile], options, host);
  const diagnostics = tsMod.getPreEmitDiagnostics(program)
    .filter((d) => d.file && virtual.has(norm(d.file.fileName)));
  if (diagnostics.length === 0) {
    console.log(`Rose Frame Driver: ${checked} script${checked === 1 ? '' : 's'} type-checked, no errors`);
    return;
  }
  for (const d of diagnostics) {
    const at = d.file ? tsMod.getLineAndCharacterOfPosition(d.file, d.start ?? 0) : null;
    const where = d.file && at
      ? `${path.relative(SRC_DIR, d.file.fileName)}(${at.line + 1},${at.character + 1})`
      : 'rosefd';
    const text = tsMod.flattenDiagnosticMessageText(d.messageText, '\n');
    const kind = d.category === 1 ? 'error' : 'warning';
    console.error(`${where}: ${kind} TS${d.code}: ${text}`);
  }
  const errors = diagnostics.filter((d) => d.category === 1).length;
  console.error(`Rose Frame Driver: ${errors} type error${errors === 1 ? '' : 's'} in ${checked} script${checked === 1 ? '' : 's'}`);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'dev') dev();
else if (cmd === 'build') build();
else if (cmd === 'preview') preview();
else if (cmd === 'serve') serve();
else if (cmd === 'new') scaffold();
else if (cmd === 'check') check();
else console.log('Usage: rosefd dev|build|preview|serve|new|check [dir]   (dir defaults to the current directory; dist/ is written there)');
