// Rose Frame Driver CLI - simplest possible SSR + static server

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pathToFileURL } from 'url';
import { buildProject, type RouteInfo } from '../compiler/index.js';
import { getHtmlShell, getClientSource, shellOpen, clientScriptTag, securityHeaders, setBundleMode } from './shell.js';

type Encoding = 'br' | 'gzip' | 'deflate';

function pickEncoding(req: any): Encoding | null {
  const ae: string = req.headers['accept-encoding'] || '';
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  if (ae.includes('deflate')) return 'deflate';
  return null;
}

function compress(enc: Encoding, data: string | Buffer): Buffer {
  if (enc === 'br') return zlib.brotliCompressSync(data);
  if (enc === 'gzip') return zlib.gzipSync(data);
  return zlib.deflateSync(data);
}

function createCompressor(enc: Encoding): zlib.Gzip | zlib.Deflate | zlib.BrotliCompress {
  if (enc === 'br') return zlib.createBrotliCompress();
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

async function sendWebResponse(web: any, res: any): Promise<void> {
  web.headers.forEach((v: string, k: string) => res.setHeader(k, v));
  res.statusCode = web.status;
  res.end(Buffer.from(await web.arrayBuffer()));
}

const fileCache = new Map<string, { mtimeMs: number; raw: Buffer; br: Buffer; gzip: Buffer; etag: string }>();

const ROOT = process.cwd();
const EXAMPLE_DIR = path.join(ROOT, 'oboext');
const OUT_DIR = path.join(ROOT, 'dist');
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
  const { routes, bundle } = await buildProject(EXAMPLE_DIR, OUT_DIR);
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
    await fs.promises.writeFile(path.join(routeDir, 'index.html'), getHtmlShell(page.html, page.state, page.head, page.csr !== false));
    console.log(`prerendered ${routePath} -> ${path.relative(ROOT, path.join(routeDir, 'index.html'))}`);
  };

  for (const info of routes) {
    if ((ssrModule.dynamicRoutes as string[]).includes(info.routePath)) {
      console.log(`dynamic route ${info.routePath}: reads the request context, rendered on demand`);
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
      console.log(`prerendered api ${routePath} -> ${path.relative(ROOT, outFile)}`);
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

function pageHeaders(ssrModule: any, pathname: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(securityHeaders(getClientSource()))) headers[k.toLowerCase()] = v;
  const own = ssrModule.headersFor?.(pathname) as Record<string, string> | null | undefined;
  if (own) for (const [k, v] of Object.entries(own)) headers[k.toLowerCase()] = v;
  return headers;
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
        await fs.promises.writeFile(filePath, getHtmlShell(page.html, page.state, page.head, page.csr !== false));
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

function serveStatic(dir: string, isr = false): (req: any, res: any) => void {
  return (req, res) => {
    loadServer().then(async (ssrModule: any) => {
      const apiPath0 = pathnameOf(req.url);
      const isPagePost = req.method === 'POST' && !ssrModule.isApi(apiPath0);
      if (!isPagePost && ssrModule.middleware) {
        const mw = await ssrModule.runMiddleware(req);
        if (mw) {
          await sendWebResponse(mw, res);
          return;
        }
      }
      const apiPath = pathnameOf(req.url);
      if (ssrModule.isApi(apiPath)) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks);
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) {
              if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
            }
            const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
              method: req.method || 'GET',
              headers,
              body: body.length > 0 ? body : undefined,
            });
            const apiRes = await ssrModule.handleApi(req.method || 'GET', apiPath, request);
            apiRes.headers.forEach((v: string, k: string) => res.setHeader(k, v));
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
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks);
            const form = await new Response(body, {
              headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded' },
            }).formData();
            if (ssrModule.middleware) {
              const mw = await ssrModule.runMiddleware(req, form);
              if (mw) {
                await sendWebResponse(mw, res);
                return;
              }
            }
            const page = await ssrModule.renderPage(req.url || '/', form);
            sendHtml(req, res, page.status ?? 200, getHtmlShell(page.html, page.state, page.head, page.csr !== false), pageHeaders(ssrModule, pathnameOf(req.url || '/')));
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
            gzip: zlib.gzipSync(raw),
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
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', rev ? `public, max-age=0, stale-while-revalidate=${rev.seconds}` : 'public, max-age=3600');
        res.setHeader('ETag', entry.etag);
        res.setHeader('Vary', 'Accept-Encoding');
        if (ext === '.html') {
          for (const [k, v] of Object.entries(pageHeaders(ssrModule, pathnameOf(req.url)))) res.setHeader(k, v);
        }
        if (req.headers['if-none-match'] === entry.etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        const enc = pickEncoding(req);
        res.statusCode = 200;
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
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Vary', 'Accept-Encoding');
        for (const [k, v] of Object.entries(pageHeaders(ssrModule, pathnameOf(safe2)))) res.setHeader(k, v);
        let write: (chunk: string) => void;
        let done: () => void;
        if (enc) {
          res.setHeader('Content-Encoding', enc);
          const compressor = createCompressor(enc);
          compressor.pipe(res);
          write = (chunk) => compressor.write(chunk);
          done = () => compressor.end();
        } else {
          write = (chunk) => res.write(chunk);
          done = () => res.end();
        }
        await ssrModule.renderPageStream(safe2, write, shellOpen(), clientScriptTag(getClientSource()));
        done();
        return;
      }
      const page = await ssrModule.renderPage(safe2);
      sendHtml(req, res, page.status ?? 200, getHtmlShell(page.html, page.state, page.head, page.csr !== false), pageHeaders(ssrModule, pathnameOf(safe2)));
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

/** The version from package.json - one source of truth, no constant to drift. */
function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function dev(): Promise<void> {
  console.log(`🌹 Rose Frame Driver v${version()} dev server starting...`);
  try {
    await build();
  } catch (err) {
    console.error('Initial build failed (server still running):', err instanceof Error ? err.message : err);
  }

  let timeout: any;
  fs.watch(EXAMPLE_DIR, { recursive: true }, () => {
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

const cmd = process.argv[2];
if (cmd === 'dev') dev();
else if (cmd === 'build') build();
else if (cmd === 'preview') preview();
else console.log('Usage: rosefd dev|build|preview');
