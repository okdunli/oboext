// Rose Frame Driver Edge adapter - Web-standard fetch handler.

import { pathToFileURL } from 'url';
import { join } from 'path';
import { buildShell, shellOpen, clientScriptTag, securityHeaders } from './shell.js';

type ServerModule = {
  renderPage(pathname: string, form?: FormData): Promise<{ html: string; state: string; head: string[]; status?: number; csr?: boolean }>;
  renderPageStream(pathname: string, write: (chunk: string) => void, shellOpen: string, clientTag: string): Promise<number>;
  canStream(pathname: string): boolean;
  isNoJs(pathname: string): boolean;
  isApi(pathname: string): boolean;
  handleApi(method: string, pathname: string, request: Request): Promise<Response>;
  /** pages/_middleware.rose's handler, or null when the project has none */
  middleware: ((request: Request) => Promise<Response | void | null>) | null;
  /** run the middleware once per request; returns its short-circuit Response or null */
  runMiddleware(rawReq: any, form?: FormData): Promise<Response | null>;
  /** routes whose component reads getContext(): never prerendered, always live */
  dynamicRoutes: string[];
 /** per-route response headers [] when no route exports any */
  routeHeaders: Array<{ pattern: string; headers: Record<string, string> }>;
  /** the route's own exported headers for a pathname, or null */
  headersFor(pathname: string): Record<string, string> | null;
};

/**
 * Create a fetch handler from a built rosefd project.
 * @param outDir directory containing server.js and client.js
 */
export async function createEdgeHandler(outDir: string): Promise<(request: Request) => Promise<Response>> {
  const mod: ServerModule = await import(pathToFileURL(join(outDir, 'server.js')).href);
  let client: string | null = null;
  let styles = '';
  try {
    client = await (await import('fs/promises')).readFile(join(outDir, 'client.js'), 'utf-8');
  } catch {
    client = null;
  }
  try {
    styles = await (await import('fs/promises')).readFile(join(outDir, 'styles.css'), 'utf-8');
  } catch {
    styles = '';
  }
  let broken = new Set<string>();
  try {
    broken = new Set(JSON.parse(await (await import('fs/promises')).readFile(join(outDir, 'broken.json'), 'utf-8')));
  } catch {
    broken = new Set();
  }

  const pageHeaders = (pathname: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (client) for (const [k, v] of Object.entries(securityHeaders(client))) headers[k.toLowerCase()] = v;
    const own = mod.headersFor?.(pathname);
    if (own) for (const [k, v] of Object.entries(own)) headers[k.toLowerCase()] = v;
    return headers;
  };

  return async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (mod.middleware) {
      const mw = await mod.runMiddleware(request);
      if (mw) return mw;
    }
    if (mod.isApi(pathname)) {
      return mod.handleApi(request.method, pathname, request);
    }
    const form = request.method === 'POST' ? await request.formData() : undefined;
    if (!form && !broken.has(pathname) && mod.canStream(pathname) && !mod.isNoJs(pathname)) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await mod.renderPageStream(
            pathname,
            (chunk) => controller.enqueue(encoder.encode(chunk)),
            shellOpen(styles),
            clientScriptTag(client)
          );
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(pathname) }
      });
    }
    const page = await mod.renderPage(pathname, form);
    const html = buildShell(page.html, page.state, client, page.head, styles, page.csr !== false);
    return new Response(html, {
      status: page.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(pathname) }
    });
  };
}
