// Rose Frame Driver Compiler - Compile .rose components to SSR + client-resume JS

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const COMPONENT_RE = /<script>([\s\S]*?)<\/script>/;
const TEMPLATE_RE = /<template>([\s\S]*?)<\/template>/;
const HEAD_RE = /<head>([\s\S]*?)<\/head>/;
const STYLE_RE = /<style>([\s\S]*?)<\/style>/;
const DECL_RE = /(?:let|const|var)\s+(\w+)[^=]*=\s*\$(state|data)\b/g;
const DECL_CAST_RE = /^\s+as\s+[^;\n]+/;
const SETSTATE_RE = /\$setState\(([^,]+),\s*([^)]+)\)/g;
const EVENT_RE = /on:(\w+)=\{([^}]+)\}/g;
const SLOT_RE = /<slot\s*\/?>/g;
/** A named slot: `<slot name="row" item={post} />` . The lookahead
 *  keeps the plain `<slot />` out of it - that one is the default slot. */
const SLOT_NAMED_RE = /<slot\s+((?=[^>]*\bname\s*=)[^>]*?)\/?>/g;

// Encode a named slot tag as the template expression `__slot('row', [['item', (post)]])` - array pairs.
function encodeSlotCall(attrs: string): string {
  const name = /\bname\s*=\s*["'](\w+)["']/.exec(attrs)?.[1];
  if (!name) throw new Error('<slot> with attributes must declare a name: <slot name="row" ... />');
  const pairs = [...attrs.matchAll(/\b(\w+)\s*=\s*\{([^}]*)\}/g)]
    .filter((m) => m[1] !== 'name')
    .map((m) => `['${m[1]}', (${m[2].trim()})]`);
  return `${JSON.stringify(name)}, [${pairs.join(', ')}]`;
}
const BOUNDARY_FALLBACK = '<p>This section failed to render.</p>';
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const TS_LOADER = { loader: { '.js': 'ts' as const } };

export interface CompileResult {
  ssr: string;
  client: string;
  stateKeys: string[];
  actionNames: string[];
 /** The page exports `beforeAction` (the action guard), or null */
  guardName: string | null;
  /** scoped CSS from the component's <style> block ('' when it has none) */
  style: string;
  /** the component exports `params` (dynamic-route prerender enumeration) */
  hasParams: boolean;
  /** api route: the module source (handlers stay exported verbatim) */
  api?: string;
  /** HTTP method names the api route exports (GET/POST/...) */
  apiMethods?: string[];
  /** api route exports `prerender = true` (bake its GET body at build time) */
  hasPrerender?: boolean;
  /** the component reads the request context (getContext()): it is dynamic */
  usesContext?: boolean;
  /** the component exports `revalidate = N` (ISR window in seconds) */
  revalidate?: number;
  /** the component exports `csr = false` (document ships without the client bundle) */
  csr?: boolean;
  /** the component exports `prefetch = 'off' | 'hover' | 'viewport' | 'all'` (app-global link-prefetch strategy) */
  prefetch?: string;
 /** the component exports `bundle = 'inline' | 'split'` (app-global client bundle mode) */
  bundle?: string;
 /** The static analysis says this component needs the client bundle */
  needsClient?: boolean;
 /** WHY it needs the client - the rules that fired, for the build report */
  clientReasons?: string[];
  /**
 * Shapes that MIGHT need JavaScript but the syntactic
   * predicate cannot prove, on a component that otherwise ships none (an
   * inline on* attribute, a javascript: URL, eval/new Function). Warnings,
   * never errors: the document still ships, but the build says it out loud.
   */
  jsWarnings?: string[];
  /** the component exports `headers = { ... }` (per-route response headers) */
  headers?: Record<string, string>;
  /**
 * The component exports `csp = { nonce: true }` - its documents get a
   * per-request nonce policy instead of the hashed one. Never prerendered: a
   * baked file cannot carry a fresh nonce.
   */
  cspNonce?: boolean;
  /**
 * The component's props - `export let title = 'x'` in its script.
   * A prop is a plain value the caller passes per invocation (never a
   * signal: the parent re-renders the child when a prop changes), so it is
   * read straight from the props object with its default as the fallback.
   */
  props?: Array<{ name: string; def: string | null }>;
  /**
 * `.rose` imports this component makes, resolved to module indices.
   * The specifiers are rewritten per bundle (ssr/client) by the generators,
   * so one source resolves against both module sets.
   */
  roseImports?: Array<{ name: string; specifier: string; index: number }>;
 /** This file lives in src/components/ (a reusable component, not a route) */
  isComponent?: boolean;
}

export interface RouteInfo {
  filePath: string;
  routePath: string;
  pattern: string;
  paramNames: string[];
  isLayout: boolean;
  /** pages/404.rose: the not-found page, not a matchable route */
  isNotFound: boolean;
  /** pages/500.rose: the error page for routes whose render throws */
  isError: boolean;
  /** pages/api/*.rose: a Web-standard handler route, not an HTML page */
  isApi: boolean;
  /** pages/_middleware.rose: the request interceptor, not a route */
  isMiddleware: boolean;
 /** src/components/*.rose: a reusable component, never a route */
  isComponent?: boolean;
}

interface Decl {
  name: string;
  kind: 'state' | 'data';
  expr: string;
  start: number;
  end: number;
}

/**
 * Rewrite bare state reads as getter calls: `count` -> `count()`.
 *
 * A regex cannot do this safely - it would rewrite state names inside string
 * literals (`.get('name')` -> `.get('name()')`), template text, and comments.
 * This scanner copies those verbatim and only rewrites identifier positions,
 * keeping the original exclusions: not after [\w$.] (property access) and not
 * before [\w$:(] (call, declaration, or object key).
 */
function callifyStateReads(script: string, names: string[]): string {
  if (names.length === 0) return script;
  const scan = (src: string): string => {
    let out = '';
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== ch) {
          if (src[j] === '\\') j++;
          j++;
        }
        out += src.slice(i, Math.min(j + 1, src.length));
        i = j + 1;
        continue;
      }
      if (ch === '`') {
        out += ch;
        i++;
        while (i < src.length && src[i] !== '`') {
          if (src[i] === '\\') {
            out += src.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (src[i] === '$' && src[i + 1] === '{') {
            let depth = 1;
            let j = i + 2;
            while (j < src.length && depth > 0) {
              if (src[j] === '{') depth++;
              else if (src[j] === '}') depth--;
              if (depth === 0) break;
              j++;
            }
            out += '${' + scan(src.slice(i + 2, j)) + '}';
            i = j + 1;
            continue;
          }
          out += src[i];
          i++;
        }
        out += '`';
        i++;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i);
        const end = nl === -1 ? src.length : nl;
        out += src.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const close = src.indexOf('*/', i + 2);
        const end = close === -1 ? src.length : close + 2;
        out += src.slice(i, end);
        i = end;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j])) j++;
        const word = src.slice(i, j);
        const prev = out.length ? out[out.length - 1] : '';
        const next = src[j] ?? '';
        const rewrite = names.includes(word)
          && !/[\w$.]/.test(prev)
          && !/[\w$:(]/.test(next);
        out += rewrite ? `${word}()` : word;
        i = j;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  };
  return scan(script);
}

/**
 * The template-side twin of callifyStateReads: every `{...}` expression gets
 * the same bare-read rewrite, and nothing else does. A whole-template scan
 * would also rewrite the word in prose - `<p>likes {likes()}</p>` would print
 * "likes()" - so the pass walks expressions only. Block syntax ({#if …},
 * {#each …}) rides along: callifying `rows` in `{#each rows as row}` is
 * exactly what the each branch already expects (`rows()`).
 */
function callifyTemplateExprs(template: string, names: string[]): string {
  if (names.length === 0) return template;
  return template.replace(/\{([^{}]*)\}/g, (whole, expr) =>
    `{${callifyStateReads(expr, names)}}`);
}

/**
 * The <script> block of a .rose source, verbatim. `rosefd check` must
 * type-check exactly what the compiler will embed, so the extraction lives
 * here and both consumers share it - one regex, one truth.
 */
export function scriptOf(source: string): string | null {
  return source.match(COMPONENT_RE)?.[1] ?? null;
}

/**
 * The per-request bag the runtime hooks receive. Web-standard on purpose:
 * the same object reaches a hook on the Node server, the preview server and
 * the edge adapter, so hook code is written once and runs everywhere.
 * `state` is scratch space - one hook writes, a later hook (or the page,
 * through getContext()) reads.
 */
export interface RequestHookContext {
  request: Request;
  url: URL;
  method: string;
  pathname: string;
  state: Record<string, unknown>;
}

/**
 * A plugin, in two halves. `transform` runs at BUILD time over each
 * component's raw source. The rest run at RUNTIME: `onRequest`/`onResponse`
 * once per request (Node server, dev/preview and edge adapter alike),
 * `onServe`/`onShutdown` once per worker process under `rosefd serve`
 * (Node only - an edge runtime owns the lifecycle, there is no worker start
 * to hook).
 *
 * A runtime hook is bundled into dist/server.js together with the config
 * module that declares it, so its imports must load in the target runtime
 * (Node and edge both): keep node-only code out of rosefd.config.js.
 */
export interface Plugin {
  name: string;
  transform?(code: string, filePath: string): string | Promise<string>;
  /** Before routing and middleware. Return a Response to short-circuit (auth wall, rate limit, maintenance page). */
  onRequest?(ctx: RequestHookContext): Response | void | Promise<Response | void>;
  /** After the response exists, before it is sent. Return a Response to replace it. */
  onResponse?(ctx: RequestHookContext, res: Response): Response | void | Promise<Response | void>;
  /** Worker start: open a connection pool, warm a cache. */
  onServe?(meta: { port: number; workers: number }): void | Promise<void>;
  /** Worker drain, before exit: close the pool. */
  onShutdown?(): void | Promise<void>;
}

/**
 * The i18n half of rosefd.config.js - a named export beside the
 * plugins:
 *
 *   export const i18n = { preload: ['en', 'zh'] };
 *
 * `preload` lists the locales baked into the CLIENT bundle. The default is
 * every locale: a language switch then costs zero requests, which is the
 * one-request bet taken to its conclusion. An app with many languages lists
 * the ones it wants inline; the rest are written to dist/locales/<lang>.json
 * and fetched on first use (ensureLocale in the runtime). The SERVER bundle
 * always carries every locale - it renders any language on demand, and its
 * size is nobody's hot path.
 */
export interface I18nConfig {
  preload?: string[];
}

export interface Rose Frame DriverConfig {
  plugins: Plugin[];
  i18n: I18nConfig;
}

/**
 * Plugins live in `<root>/rosefd.config.js` as the default export: an array
 * of `{ name, transform, onRequest, onResponse, onServe, onShutdown }`.
 * `transform` runs over each component's raw source (template + script +
 * style, before any parsing) at build time; the runtime hooks are bundled
 * into dist/server.js by build() below. trade-off: transform alone covers
 * macros, custom syntax, includes and auto-imports - a transform can rewrite
 * anything, including the script block; the request/serve hooks cover auth,
 * logging and lifecycle, which no source rewrite can express. The import is
 * cache-busted per build so a config edit takes effect on the dev server's
 * next rebuild, and a missing file is simply "no config" (existence is
 * checked first, so a config with a syntax error still fails loudly).
 * One import, one evaluation: the i18n options ride in the same module.
 */
export async function loadConfig(root: string): Promise<Rose Frame DriverConfig> {
  const file = path.join(root, 'rosefd.config.js');
  if (!fs.existsSync(file)) return { plugins: [], i18n: {} };
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  return {
    plugins: (mod.default as Plugin[] | undefined) ?? [],
    i18n: (mod.i18n as I18nConfig | undefined) ?? {},
  };
}

/** The plugins alone (the serve command's lifecycle hooks). */
export async function loadPlugins(root: string): Promise<Plugin[]> {
  return (await loadConfig(root)).plugins;
}

/**
 * The module registry the build hands every compileComponent call.
 * Maps a resolved .rose file to its module index and scope key, so an
 * `import Card from '../components/Card.rose'` can be rewritten to the
 * compiled module in BOTH bundles (the specifier differs per bundle, the
 * index does not). One map, built once per build from the full file list -
 * a component may import a component, so the graph is resolved before any
 * compilation starts.
 *
 * `slots` is the child's slot declaration (`<slot name="row" item={post}>`),
 * pre-scanned from its template: the parent needs the names the child passes
 * INTO a slot to resolve them in the slot content it writes, and compilation
 * order cannot guarantee the child is compiled first.
 */
export type RoseRegistry = Map<string, { index: number; scopeKey: string; slots: Array<{ name: string; props: string[] }> }>;

/**
 * Resolve every `.rose` import in a script against the registry. Returns the
 * rewritten script plus the (local name, specifier, index) triples, so the
 * generators can emit the right module path per bundle. An unresolvable
 * specifier fails the build naming the file and the import - a typo'd
 * component path must not silently ship a broken bundle.
 */
function resolveRoseImports(script: string, fromFile: string, registry: RoseRegistry): { script: string; imports: Array<{ name: string; specifier: string; index: number }> } {
  const imports: Array<{ name: string; specifier: string; index: number }> = [];
  const resolve = (spec: string): { index: number; scopeKey: string } => {
    const abs = path.resolve(path.dirname(fromFile), spec);
    const hit = registry.get(abs);
    if (!hit) {
      throw new Error(`${path.basename(fromFile)}: cannot import '${spec}' - no .rose file at ${abs}. A component lives under src/components/ (or src/pages/) and is imported by relative path.`);
    }
    return hit;
  };
  let rewritten = script.replace(/import\s+(\w+)\s+from\s*(['"])([^'"]+\.rose)\2/g, (whole, name, q, spec) => {
    const hit = resolve(spec);
    imports.push({ name, specifier: spec, index: hit.index });
    return `import { render as ${name} } from ${q}__rose_${hit.index}__${q}`;
  });
  rewritten = rewritten.replace(/import\s*(\{[^}]*\})\s*from\s*(['"])([^'"]+\.rose)\2/g, (whole, clause, q, spec) => {
    const hit = resolve(spec);
    const alias = /\bas\s+(\w+)/.exec(clause)?.[1] ?? 'render';
    imports.push({ name: alias, specifier: spec, index: hit.index });
    return `import ${clause} from ${q}__rose_${hit.index}__${q}`;
  });
  return { script: rewritten, imports };
}

/**
 * Rewrite the `__rose_N__` placeholders to this bundle's module paths. Both
 * bundles are generated from the same resolved script, so one placeholder
 * resolves to two different files - the only per-bundle difference in the
 * whole component pipeline.
 */
function rewriteRoseImports(script: string, kind: 'ssr' | 'client'): string {
  return script.replace(/from\s*(['"])__rose_(\d+)__\1/g, (_, q, n) => `from ${q}./comp-${n}.${kind}.js${q}`);
}

/**
 * Pre-scan a file's template for its slot declarations -
 * `<slot name="row" item={post}>` -> { name: 'row', props: ['item'] }.
 * Cheap regex on purpose: the parent's compiler needs the names the child
 * passes INTO a slot, before (and independently of) compiling the child.
 */
function scanSlotDecls(filePath: string): Array<{ name: string; props: string[] }> {
  let src: string;
  try {
    src = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const noBlocks = src.replace(STYLE_RE, '');
  const tpl = noBlocks.match(TEMPLATE_RE)?.[1] ?? noBlocks.replace(HEAD_RE, '').replace(COMPONENT_RE, '').trim();
  const out: Array<{ name: string; props: string[] }> = [];
  for (const m of tpl.matchAll(/<slot\s+([^>]*?)\/?>/g)) {
    const name = /\bname\s*=\s*["'](\w+)["']/.exec(m[1]);
    if (!name) continue;
    const props = [...m[1].matchAll(/\b(\w+)\s*=\s*\{/g)].map((x) => x[1]).filter((n) => n !== 'name');
    out.push({ name: name[1], props });
  }
  return out;
}

/**
 * Lift `import` statements out of a script block to module scope. The
 * script body is embedded inside render(), where an import declaration is a
 * syntax error - and a component import is exactly what a page/component
 * script now carries. Line-based on purpose: multi-line imports are tracked
 * by brace/paren depth and end at their `from '...'` clause.
 */
function hoistImports(script: string): { imports: string; rest: string } {
  const imports: string[] = [];
  const rest: string[] = [];
  let buf: string[] | null = null;
  let depth = 0;
  const done = (line: string) => depth <= 0 && /from\s*['"][^'"]+['"]\s*;?\s*$/.test(line);
  for (const line of script.split('\n')) {
    if (buf) {
      buf.push(line);
      for (const ch of line) {
        if (ch === '{' || ch === '(') depth++;
        else if (ch === '}' || ch === ')') depth--;
      }
      if (done(line)) {
        imports.push(buf.join('\n'));
        buf = null;
      }
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      buf = [line];
      depth = 0;
      for (const ch of line) {
        if (ch === '{' || ch === '(') depth++;
        else if (ch === '}' || ch === ')') depth--;
      }
      if (done(line)) {
        imports.push(line);
        buf = null;
      }
      continue;
    }
    rest.push(line);
  }
  if (buf) imports.push(buf.join('\n'));
  return { imports: imports.join('\n'), rest: rest.join('\n') };
}

export async function compileComponent(filePath: string, publicDir: string, scopeKey: string, isApi = false, plugins: Plugin[] = [], registry: RoseRegistry = new Map()): Promise<CompileResult> {
  let source = await fs.promises.readFile(filePath, 'utf-8');
  for (const p of plugins) {
    if (!p.transform) continue;
    try {
      source = await p.transform(source, filePath);
    } catch (err) {
      throw new Error(`plugin ${p.name} failed on ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (isApi) {
    const scriptMatch = source.match(COMPONENT_RE);
    const rawScript = scriptMatch?.[1] ?? '';
    const apiMethods = [...rawScript.matchAll(/(?:^|\n)\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name) => HTTP_METHODS.has(name));
    const usesContext = /getContext\s*\(/.test(rawScript);
    const hasPrerender = !usesContext && /(?:^|\n)\s*export\s+(?:const|let|var)\s+prerender\s*=\s*true\b/.test(rawScript);
    const hoisted = hoistImports(resolveRoseImports(rawScript, filePath, registry).script);
    return {
      ssr: '',
      client: '',
      stateKeys: [],
      actionNames: [],
      guardName: null,
      style: '',
      hasParams: false,
      api: `import { getContext } from './runtime.js';\n${rewriteRoseImports(`${hoisted.imports}\n${hoisted.rest}`, 'ssr').trim()}`,
      apiMethods,
      hasPrerender,
      usesContext,
    };
  }

  const styleMatch = source.match(STYLE_RE);
  const scopedStyle = styleMatch?.[1] ? scopeCss(styleMatch[1], scopeKey) : '';
  const sourceNoBlocks = source.replace(STYLE_RE, '');

  const scriptMatch = sourceNoBlocks.match(COMPONENT_RE);
  const roseResolved = resolveRoseImports(scriptMatch?.[1] ?? '', filePath, registry);
  const rawScript = roseResolved.script;
  const roseImports = roseResolved.imports;
  const { imports: importStmts, rest: scriptNoImports } = hoistImports(rawScript);
  const isComponent = registry.get(filePath)?.scopeKey.startsWith('components/') ?? false;
  if (isComponent && /\$data\s*\(/.test(rawScript)) {
    throw new Error(
      `${filePath}: $data() is not allowed in a component - an imported component renders synchronously inside its parent. ` +
      `Fetch in the page's $data (or pages/_middleware.rose) and pass the value down as a prop: <Card user={user()}>.`
    );
  }
  const usesContext = /getContext\s*\(/.test(rawScript) || /\$store\s*\(/.test(rawScript);
  const hasParams = /(?:^|\n)\s*export\s+(?:(?:const|let|var)\s+|(?:async\s+)?function\s+)params\b/.test(rawScript);
  const revalidateMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+revalidate\s*=\s*(\d+)\s*;?/);
  const revalidate = revalidateMatch ? Number(revalidateMatch[1]) : undefined;
  const prefetchMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+prefetch\s*=\s*['"`](\w+)['"`]\s*;?/);
  const prefetch = prefetchMatch ? prefetchMatch[1] : undefined;
  if (prefetch && !['off', 'hover', 'viewport', 'all'].includes(prefetch)) {
    throw new Error(`${filePath}: export const prefetch must be 'off', 'hover', 'viewport' or 'all'`);
  }
  const bundleMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+bundle\s*=\s*['"`](\w+)['"`]\s*;?/);
  const bundle = bundleMatch ? bundleMatch[1] : undefined;
  if (bundle && !['inline', 'split'].includes(bundle)) {
    throw new Error(`${filePath}: export const bundle must be 'inline' or 'split'`);
  }
  const csrMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+csr\s*=\s*(true|false)\s*;?/);
  const csr: boolean | undefined = csrMatch ? csrMatch[1] !== 'false' : undefined;
  if (csr === false) {
    const dead = /\son:[a-z]+\s*=/.exec(source) ?? /\b(?:onMount|onCleanup|refresh)\s*\(/.exec(rawScript);
    if (dead) {
      throw new Error(
        `${filePath}: csr = false cannot ship ${dead[0].trim()} - event wiring, onMount/onCleanup and refresh() all need the client bundle. ` +
        `(Forms still work without JS: a native POST runs the server action.)`
      );
    }
  }

  let headers: Record<string, string> | undefined;
  const headersLiteral = extractObjectLiteral(rawScript, 'headers');
  if (headersLiteral) {
    let value: unknown;
    try {
      value = new Function(`return ${headersLiteral}`)();
    } catch {
      throw new Error(`${filePath}: export const headers must be an object literal`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value as object).some((v) => typeof v !== 'string')) {
      throw new Error(`${filePath}: export const headers must be a flat map of string -> string`);
    }
    headers = value as Record<string, string>;
  }

  let cspNonce: boolean | undefined;
  const cspLiteral = extractObjectLiteral(rawScript, 'csp');
  if (cspLiteral) {
    let value: unknown;
    try {
      value = new Function(`return ${cspLiteral}`)();
    } catch {
      throw new Error(`${filePath}: export const csp must be an object literal`);
    }
    const nonce = (value as { nonce?: unknown } | null)?.nonce;
    if (nonce !== undefined && typeof nonce !== 'boolean') {
      throw new Error(`${filePath}: csp.nonce must be a boolean`);
    }
    cspNonce = nonce === true;
  }

  const { clean: scriptNoExports, exports: exportStmts, actions, props, guard } = extractExports(scriptNoImports);
  const script = scriptNoExports;
  const actionNames = new Set(actions.map((a) => a.name));

  const clientReasons: string[] = [];
  if (/\son:[a-z]+\s*=/.test(source)) clientReasons.push('event wiring (on:)');
  if (/<form[\s>]/.test(source)) clientReasons.push('a <form> (its in-place adopt is the enhancement)');
  const lifecycle = rawScript.match(/\b(?:onMount|onCleanup|refresh|adopt|\$action|\$setState)\s*\(/);
  if (lifecycle) clientReasons.push(`${lifecycle[0].replace(/\s*\($/, '')}()`);
  if (actionNames.size > 0) {                                                                          // a server action (form target or $action)
    clientReasons.push(`server action${actionNames.size > 1 ? 's' : ''} (${[...actionNames].join(', ')})`);
  }
  const needsClient = clientReasons.length > 0;

  const jsWarnings: string[] = [];
  if (!needsClient) {
    if (/\son[a-z]+\s*=\s*["'][^"']*["']/i.test(source)) {
      jsWarnings.push('an inline on* attribute (e.g. onclick="...") - it cannot fire without the bundle; use on:click or set csr = true');
    }
    if (/javascript:/i.test(source)) {
      jsWarnings.push('a javascript: URL - it needs the bundle to run; link to a real route');
    }
    if (/\b(?:eval|new Function)\s*\(/.test(rawScript)) {
      jsWarnings.push('eval()/new Function() - client code the predicate cannot see');
    }
    if (/\b(?:document|window|localStorage|sessionStorage)\s*\.|\b(?:add|remove)EventListener\s*\(|\brequestAnimationFrame\s*\(|\bMutationObserver\b|\bnavigator\s*\.|\blocation\s*\.\s*(?:href|assign|replace|reload|pathname|search|hash|origin)\b|\b(?:setTimeout|setInterval)\s*\(/.test(rawScript)) {
      jsWarnings.push('browser-only code (document./window./addEventListener/a timer/...) - a JS-free document never ships this script to the browser, so it throws on the server or runs there and never reaches the client; if the route needs the browser, set csr = true');
    }
  }

  const templateMatch = sourceNoBlocks.match(TEMPLATE_RE);
  const headMatch = sourceNoBlocks.match(HEAD_RE);
  const headContent = headMatch?.[1] ?? '';
  const sourceNoHead = sourceNoBlocks.replace(HEAD_RE, '');
  const rawTemplate = templateMatch
    ? templateMatch[1]
    : sourceNoHead.replace(COMPONENT_RE, '').trim();
  const template = scopedStyle
    ? injectScopeAttr(inlineImages(rawTemplate, publicDir), scopeKey)
    : inlineImages(rawTemplate, publicDir);

  const decls = extractDecls(script);
  const stateDecls = decls.filter((d) => d.kind === 'state');

  const setterNames = new Map<string, string>();
  stateDecls.forEach((s) => setterNames.set(s.name, `set${capitalize(s.name)}`));

  const eventBindings: Array<{ event: string; fn: string }> = [];
  let em: RegExpExecArray | null;
  EVENT_RE.lastIndex = 0;
  while ((em = EVENT_RE.exec(template))) {
    if (!actionNames.has(em[2].trim())) eventBindings.push({ event: em[1], fn: em[2] });
  }

  let cleanScript = removeRanges(script, decls.map((d) => [d.start, d.end] as [number, number]));
  cleanScript = cleanScript.replace(SETSTATE_RE, (_, key, val) => {
    const trimmedKey = key.trim().replace(/^['"`]|['"`]$/g, '');
    const setter = setterNames.get(trimmedKey) || `set${capitalize(trimmedKey)}`;
    return `${setter}(${val})`;
  });

  cleanScript = callifyStateReads(cleanScript, stateDecls.map((s) => s.name));

  const templateCalled = callifyTemplateExprs(template, stateDecls.map((s) => s.name));

  const ssrTemplate = templateCalled
    .replace(SLOT_NAMED_RE, (_w, attrs) => `{__slot(${encodeSlotCall(attrs)})}`)
    .replace(SLOT_RE, '{__slot__}')
    .replace(/on:(\w+)=\{([^}]+)\}/g, (_, ev, fn) =>
      actionNames.has(fn.trim()) ? `data-on-${ev}="$action:${fn.trim()}"` : `data-on-${ev}="${fn}"`);

  const stateDeclsCode = decls
    .map((d) => {
      const key = isComponent ? `${scopeKey}:${d.name}` : d.name;
      if (d.kind === 'state') {
        return `const [${d.name}, ${setterNames.get(d.name)!}] = state(${JSON.stringify(key)}, ${d.expr});`;
      }
      const isFn = d.expr.includes('=>') || d.expr.startsWith('function');
      const fn = isFn ? d.expr : `() => (${d.expr})`;
      return `const __had_${d.name} = hasState(${JSON.stringify(key)});
const [${d.name}, set${capitalize(d.name)}] = state(${JSON.stringify(key)}, null);
if (!__had_${d.name}) set${capitalize(d.name)}(await $data(${fn}));`;
    })
    .join('\n');

  const stateKeys = decls.map((d) => d.name);

  const comps = new Map(roseImports.map((r) => {
    const abs = path.resolve(path.dirname(filePath), r.specifier);
    const hit = registry.get(abs)!;
    return [r.name, { index: hit.index, slots: hit.slots }] as const;
  }));
  const compiledTemplate = compileTemplate(ssrTemplate, 'h', '__c', null, 0, true, comps);
  const compiledHead = headContent.trim() ? compileTemplate(headContent, '__hd', '__hc', null, 0, false) : '';
  const hasNamedSlots = /<slot\s+[^>]*\bname\s*=/.test(template);

  const ssrExports = actions.length > 0 ? `${exportStmts}\n${actions.map((a) => a.stmt).join('\n')}` : exportStmts;
  const ssrGuard = guard ? `\n${guard}` : '';
  const isMiddleware = path.basename(filePath) === '_middleware.rose';
  const ssr = isMiddleware
    ? `${RUNTIME_IMPORTS}\n\n${importStmts}\n\n${ssrExports}\n${ssrGuard}\n\n${cleanScript}\n`
    : generateSSR(cleanScript, compiledTemplate, stateDeclsCode, ssrExports, compiledHead, props, hasNamedSlots, importStmts, isComponent, ssrGuard);
  const client = generateClient(cleanScript, compiledTemplate, stateDeclsCode, eventBindings, exportStmts, compiledHead, props, hasNamedSlots, importStmts, isComponent);

  return {
    ssr: rewriteRoseImports(ssr, 'ssr'),
    client: rewriteRoseImports(client, 'client'),
    stateKeys,
    actionNames: [...actionNames],
    guardName: guard ? 'beforeAction' : null,
    style: scopedStyle,
    hasParams,
    usesContext,
    revalidate,
    csr,
    prefetch,
    bundle,
    needsClient,
    clientReasons,
    jsWarnings,
    headers,
    cspNonce,
    props,
    roseImports,
    isComponent,
  };
}

/**
 * Collapse a declaration block's whitespace outside strings. Every byte of
 * component CSS ships inside every document, so the source's formatting is a
 * tax paid on every route; collapsing it is free - declarations are not
 * whitespace-sensitive, and quoted strings (content: "a  b") are left
 * untouched by the alternation.
 */
function minifyDecls(block: string): string {
  return block
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"']+/g, (m) =>
      m[0] === '"' || m[0] === "'" ? m : m.replace(/\s+/g, ' ').replace(/\s*([:;{},])\s*/g, '$1').trim()
    )
    .trim();
}

/**
 * Scope a component's CSS to its own subtree: every selector is prefixed
 * with the component's scope attribute, recursing into @media/@supports.
 * Trade-off: no full CSS parser - comma lists only, and @keyframes blocks
 * pass through unscoped (their from/to/to selectors are not selectors).
 * Global element rules (:root/html/body) belong in the shell's STYLES.
 */
function scopeCss(css: string, key: string): string {
  const attr = `[data-rosefd-c="${key}"]`;
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let prelude = '';
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === '{') depth++;
        else if (clean[j] === '}') depth--;
        j++;
      }
      const block = clean.slice(i + 1, j - 1);
      const sel = prelude.trim();
      if (sel.startsWith('@')) {
        out += `${sel}{${/^@(?:-[\w]+-)?keyframes/.test(sel) ? minifyDecls(block) : scopeCss(block, key)}}`;
      } else if (sel) {
        const scoped = sel.split(',').map((s) => `${attr} ${s.trim()}`).join(',');
        out += `${scoped}{${minifyDecls(block)}}`;
      }
      prelude = '';
      i = j;
      continue;
    }
    if (ch !== '}' && ch !== '\n' && ch !== '\r') prelude += ch;
    else if (ch === '}') prelude = '';
    i++;
  }
  return out.trim();
}

/**
 * Add the scope attribute to every top-level element of a template. Tag
 * depth is tracked with quoted-attribute awareness, so elements inside a
 * top-level {#if}/{#each} block are top-level at render time and get it too.
 */
function injectScopeAttr(template: string, key: string): string {
  const attr = ` data-rosefd-c="${key}"`;
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < template.length) {
    const lt = template.indexOf('<', i);
    if (lt === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, lt);
    let j = lt + 1;
    let quote = '';
    while (j < template.length) {
      const c = template[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const tagText = template.slice(lt, j + 1);
    const closing = /^<\//.test(tagText);
    const nameMatch = tagText.match(/^<\/?([a-zA-Z][\w-]*)/);
    const selfClosing = /\/>$/.test(tagText) || (nameMatch && VOID_TAGS.has(nameMatch[1].toLowerCase()));
    if (nameMatch && !closing && depth === 0 && !selfClosing) {
      const injectAt = tagText.endsWith('/>') ? tagText.length - 2 : tagText.length - 1;
      out += tagText.slice(0, injectAt) + attr + tagText.slice(injectAt);
      depth++;
    } else {
      out += tagText;
      if (nameMatch) depth += closing ? -1 : selfClosing ? 0 : 1;
    }
    i = j + 1;
  }
  return out;
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr']);

const EXPORT_RE = /^[ \t]*export\s+(?:(const|let|var)|(?:async\s+)?function)\s+(\w+)/gm;

/**
 * Lift top-level `export const/let/var/function` statements out of the script
 * body. They must be self-contained (no references to state or template
 * scope) - they exist for build-time consumers like dynamic-route `params`.
 *
 * Every exported ASYNC function is a SERVER-ONLY action (server-action semantics:
 * `export const params` and sync helpers stay shared, async exports are
 * server code). `action` is the conventional name a <form method="POST">
 * posts to; any other name is reachable from an event handler
 * (`on:click={like}` compiles to `$action('like')`) or a hidden form field.
 * Action bodies reach the SSR module but NEVER the client bundle.
 */
/**
 * Extract an exported object literal (`export const headers = { ... }`) by
 * name, with a balanced-brace scan so nested values survive the capture.
 * Returns the raw literal text, or null when the export is absent.
 */
function extractObjectLiteral(script: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)\\s*export\\s+(?:const|let|var)\\s+${name}\\s*=\\s*`).exec(script);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (script[i] !== '{') return null;
  const start = i;
  let depth = 0;
  for (; i < script.length; i++) {
    const ch = script[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return script.slice(start, i);
}

export function extractExports(script: string): { clean: string; exports: string; actions: Array<{ name: string; stmt: string }>; props: Array<{ name: string; def: string | null }>; guard: string } {
  const stmts: string[] = [];
  const actions: Array<{ name: string; stmt: string }> = [];
  const props: Array<{ name: string; def: string | null }> = [];
  const guards: string[] = [];
  let out = '';
  let pos = 0;
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(script))) {
    const kind = m[1];
    const start = m.index + m[0].indexOf('export');
    let i = start + m[0].length - m[0].indexOf('export');
    if (kind) {
      let depth = 0;
      while (i < script.length) {
        const ch = script[i];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        } else if (depth === 0 && ch === ';') {
          i++;
          break;
        } else if (depth === 0 && ch === '\n') {
          const rest = script.slice(i + 1);
          if (!/^\s*[.([{+\-*/?:,=&|]/.test(rest)) {
            i++;
            break;
          }
        }
        i++;
      }
      if (script[i] === ';') i++;
    } else {
      while (i < script.length && script[i] !== '{') i++;
      let depth = 0;
      while (i < script.length) {
        const ch = script[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
    }
    out += script.slice(pos, start);
    const stmt = script.slice(start, i).trim();
    const asyncFn = stmt.match(/^export\s+async\s+function\s+(\w+)/);
    const anyFn = stmt.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (anyFn?.[1] === 'beforeAction') {
      guards.push(stmt);
    } else if (asyncFn) {
      actions.push({ name: asyncFn[1], stmt });
    } else if (kind === 'let') {
      const pm = stmt.match(/^export\s+let\s+(\w+)\s*(?:=\s*([\s\S]*?))?\s*;?$/);
      if (pm) props.push({ name: pm[1], def: pm[2]?.trim() ?? null });
      else stmts.push(stmt);
    } else {
      stmts.push(stmt);
    }
    pos = i;
  }
  out += script.slice(pos);
  return { clean: out, exports: stmts.join('\n'), actions, props, guard: guards.join('\n') };
}

function extractDecls(script: string): Decl[] {
  const decls: Decl[] = [];
  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(script))) {
    let j = m.index + m[0].length;
    const skipSpace = () => { while (j < script.length && /\s/.test(script[j])) j++; };
    skipSpace();
    if (script[j] === '<') {
      let depth = 0;
      while (j < script.length) {
        const ch = script[j];
        if (ch === '<') depth++;
        else if (ch === '>' && script[j - 1] !== '=') {
          depth--;
          if (depth === 0) { j++; break; }
        } else if (ch === '=' && script[j + 1] === '>') j++;
        j++;
      }
      skipSpace();
    }
    if (script[j] !== '(') continue;
    const open = j + 1;
    let depth = 1;
    let i = open;
    while (i < script.length && depth > 0) {
      const ch = script[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    let end = i;
    const cast = DECL_CAST_RE.exec(script.slice(i));
    if (cast) end = i + cast[0].length;
    if (script[end] === ';') end++;
    decls.push({
      name: m[1],
      kind: m[2] as 'state' | 'data',
      expr: script.slice(open, i - 1).trim(),
      start: m.index,
      end,
    });
  }
  return decls;
}

function removeRanges(text: string, ranges: Array<[number, number]>): string {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [start, end] of sorted) {
    out += text.slice(pos, start);
    pos = end;
  }
  out += text.slice(pos);
  return out;
}

/**
 * Compile a .rose template to statements that build an HTML string with
 * reactive markers, and push update closures into the shared `closes` array.
 *
 * Marker protocol (identical on server and client, so the client can adopt
 * the SSR DOM instead of re-rendering it):
 *   text:      <!--⟦m:K⟧-->value          wire() updates the following text node
 *   if block:  <!--⟦i:K⟧-->html<!--⟦/i:K⟧-->   wire() inserts/removes the block
 *   each list: <!--⟦l:K⟧-->items<!--⟦/l:K⟧-->  wire() rebuilds the list
 *   attr:      name="value" data-b="K:name"   wire() re-sets the attribute
 *
 * Text/attr values are HTML-escaped on the server; wire() writes raw values
 * because DOM text nodes and attributes are not HTML-parsed.
 *
 * `comps` maps an imported component's local name to its module index
 * and slot declarations. A `<Card title={x}>` tag compiles to a call of that
 * module's render() - the child pushes its markers into the SAME closes array
 * the parent is using, so one wire() pass covers the whole tree (the same
 * trick the layout chain already uses with children html).
 */

/**
 * Auto-call a BARE state read and nothing else. The callify pass has already
 * rewritten a bare name to `name()`, so what reaches here is that - or an
 * expression the developer wrote (a comparison, a member read, a call with
 * arguments). Appending () to THOSE is a crash the developer reads as a
 * framework bug: `{#if flash().name}` must not become `flash().name()`, and
 * `{#each rows.filter(ok) as row}` must not become `rows.filter(ok)()`.
 */
function autoCall(expr: string): string {
  const e = expr.trim();
  return /^[A-Za-z_$][\w$]*$/.test(e) ? `${e}()` : e;
}

function compileTemplate(
  template: string,
  acc: string,
  closes: string,
  scope: string | null,
  depth: number,
  markers = true,
  comps: Map<string, { index: number; slots: Array<{ name: string; props: string[] }> }> = new Map()
): string {
  let result = '';
  let remaining = template;
  let blockId = 0;

  const nextId = () => `${depth}_${blockId++}`;

  while (remaining.length > 0) {
    const ifMatch = remaining.match(/\{#if\s+([^}]+)\}([\s\S]*?)\{\/if\}/) as RegExpExecArray | null;
    const eachMatch = remaining.match(/\{#each\s+([\w.]+(?:\(\))?)\s+as\s+(\w+)\}([\s\S]*?)\{\/each\}/) as RegExpExecArray | null;
    const boundaryMatch = remaining.match(/\{#boundary\}([\s\S]*?)\{\/boundary\}/) as RegExpExecArray | null;
    const exprMatch = remaining.match(/\{([^{}]+)\}/) as RegExpExecArray | null;
    const compTag = comps.size > 0 ? findCompTag(remaining, comps) : null;

    const candidates: Array<{ type: string; match: RegExpExecArray; index: number; tag?: CompTag }> = [];
    if (ifMatch?.index !== undefined) candidates.push({ type: 'if', match: ifMatch, index: ifMatch.index });
    if (eachMatch?.index !== undefined) candidates.push({ type: 'each', match: eachMatch, index: eachMatch.index });
    if (boundaryMatch?.index !== undefined) candidates.push({ type: 'boundary', match: boundaryMatch, index: boundaryMatch.index });
    if (exprMatch?.index !== undefined) candidates.push({ type: 'expr', match: exprMatch, index: exprMatch.index });
    if (compTag) candidates.push({ type: 'comp', match: exprMatch!, index: compTag.start, tag: compTag });
    const earliest = candidates.length > 0
      ? candidates.reduce((a, b) => (a.index <= b.index ? a : b))
      : null;

    if (!earliest) {
      result += emitChunk(remaining, acc, closes, scope);
      break;
    }

    if (earliest.type === 'if') {
      const [, cond, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const call = autoCall(cond);
      const id = nextId();
      const innerScope = scope ?? '__s';
      const inner = compileTemplate(content.trim(), 'h', '__c', innerScope, depth + 1, markers, comps);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };\n`;
      if (markers) {
        result += `${acc} += ifMark(${closes}, () => (${call}), __b${id}${scope ? `, ${scope}` : ''});\n`;
      } else {
        result += `${acc} += (${call}) ? __b${id}(${scope ?? 'undefined'}, []) : '';\n`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'each') {
      const [, items, item, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const call = autoCall(items);
      const id = nextId();
      const itemRe = new RegExp(`\\b${item}\\b`, 'g');
      const scoped = content.trim().replace(/\{([^{}]*)\}/g, (whole, expr) =>
        `{${expr.replace(itemRe, '__s')}}`);
      const inner = compileTemplate(scoped, 'h', '__c', '__s', depth + 1, markers, comps);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };\n`;
      if (markers) {
        result += `${acc} += eachMark(${closes}, () => (${call}), __b${id});\n`;
      } else {
        result += `${acc} += (${call}).map((${item}) => __b${id}(${item}, [])).join('');\n`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'boundary') {
      const [, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const id = nextId();
      const catchesAction = /\$action:|<form[\s>]/.test(content);
      const inner = compileTemplate(content.trim(), 'h', closes, scope, depth + 1, markers, comps);
      result += `const __b${id} = (__c) => { let h = ''; ${inner} return h; };\n`;
      result += `let __bd${id} = '';\n`;
      result += catchesAction
        ? `try { $actionErrorOrThrow(); __bd${id} = __b${id}(${closes}); } catch (e) { __bd${id} = $boundaryFallback(e); }\n`
        : `try { __bd${id} = __b${id}(${closes}); } catch { __bd${id} = ${JSON.stringify(BOUNDARY_FALLBACK)}; }\n`;
      result += `${acc} += __bd${id};\n`;
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'comp') {
      const tag = earliest.tag!;
      if (tag.start > 0) result += emitChunk(remaining.substring(0, tag.start), acc, closes, scope);
      const entry = comps.get(tag.name)!;
      const id = nextId();
      let childrenSrc = '';
      let rest: string;
      if (tag.selfClosing) {
        rest = remaining.substring(tag.end);
      } else {
        const closeIdx = findClose(remaining, tag.end, tag.name);
        if (closeIdx < 0) throw new Error(`unclosed <${tag.name}> - every component tag needs its matching close tag`);
        childrenSrc = remaining.substring(tag.end, closeIdx);
        rest = remaining.substring(closeIdx + tag.name.length + 3);
      }
      const { def, named } = splitSlots(childrenSrc);
      const hasChildren = def.trim().length > 0;
      if (hasChildren) {
        result += `const __ch${id} = (__s, __c) => { let h = ''; ${compileTemplate(def, 'h', '__c', scope, depth + 1, markers, comps)} return h; };\n`;
      }
      const slotFns = named.map(([nm, src]) => {
        const decl = entry.slots.find((s) => s.name === nm);
        let content = src;
        for (const p of decl?.props ?? []) {
          content = content.replace(/\{([^{}]*)\}/g, (whole, expr) =>
            `{${expr.replace(new RegExp(`\\b${p}\\b`, 'g'), `__s.${p}`)}}`);
        }
        return `${JSON.stringify(nm)}: (__s, __c) => { let h = ''; ${compileTemplate(content, 'h', '__c', '__s', depth + 1, markers, comps)} return h; }`;
      });
      const propsObj = parseCompAttrs(tag.attrs)
        .filter((a) => a.name !== 'slot')
        .map((a) => {
          const key = a.name.startsWith('on:') ? `on${capitalize(a.name.slice(3))}` : a.name;
          const val = a.kind === 'expr' ? `(${a.value})` : a.kind === 'str' ? JSON.stringify(a.value) : 'true';
          return `${JSON.stringify(key)}: ${val}`;
        })
        .join(', ');
      const childrenArg = hasChildren ? `__ch${id}(${scope ?? 'undefined'}, ${closes})` : `''`;
      result += `${acc} += ${tag.name}(${closes}, ${childrenArg}, { ${propsObj} }, { ${slotFns.join(', ')} });\n`;
      remaining = rest;
    } else {
      const [, expr] = earliest.match;
      const trimmed = expr.trim();
      const before = remaining.substring(0, earliest.index);
      if (trimmed === '__slot__') {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += compileSlot(acc);
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const slotCall = /^__slot\((['"])(\w+)\1, \[([\s\S]*)\]\)$/.exec(trimmed);
      if (slotCall) {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += `${acc} += __slotBlock(${closes}, __sl, ${JSON.stringify(slotCall[2])}, [${slotCall[3]}]);\n`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const attrMatch = before.match(/([\w-]+)=\s*$/);
      if (attrMatch) {
        const lit = before.slice(0, before.length - attrMatch[0].length);
        if (lit) result += emitChunk(lit, acc, closes, scope);
        result += emitAttr(attrMatch[1], trimmed, acc, closes, scope, markers);
      } else {
        if (before) result += emitChunk(before, acc, closes, scope);
        const after = remaining.substring(earliest.index + earliest.match[0].length);
        const pair = after.length > 0 && !/^<[a-zA-Z/!]/.test(after) && !after.startsWith('{');
        result += emitText(trimmed, acc, closes, scope, markers, pair);
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    }
  }

  return result;
}

/** One component tag found in a template . */
interface CompTag {
  /** index of `<` in the searched string */
  start: number;
  /** index just past `>` */
  end: number;
  name: string;
  /** the raw attribute text between the tag name and `>` */
  attrs: string;
  selfClosing: boolean;
}

/**
 * Scan one tag from its `<` to its `>`, quote- and brace-aware so a `>` inside
 * an attribute expression (`title={a > b}`) does not end the tag. Returns the
 * index just past `>`, or -1 when the tag is never closed.
 */
function scanTagEnd(src: string, start: number): number {
  let j = start + 1;
  let quote = '';
  let brace = 0;
  while (j < src.length) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') brace++;
    else if (c === '}') brace = Math.max(0, brace - 1);
    else if (c === '>' && brace === 0) return j + 1;
    j++;
  }
  return -1;
}

/** The earliest open tag whose name is an imported component . */
function findCompTag(src: string, comps: Map<string, unknown>): CompTag | null {
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) return null;
    const nm = /^<([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 64));
    if (nm && comps.has(nm[1])) {
      const end = scanTagEnd(src, lt);
      if (end > 0) {
        const raw = src.slice(lt, end);
        const selfClosing = /\/>$/.test(raw);
        return { start: lt, end, name: nm[1], attrs: raw.slice(1 + nm[1].length, selfClosing ? -2 : -1), selfClosing };
      }
    }
    i = lt + 1;
  }
  return null;
}

/** Index of the `</name>` that closes the tag opened before `from` (-1: none). */
function findClose(src: string, from: number, name: string): number {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])`, 'g');
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const end = scanTagEnd(src, m.index);
    if (end < 0) return -1;
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return m.index;
    } else if (!/\/>$/.test(src.slice(m.index, end))) depth++;
  }
  return -1;
}

interface CompAttr { name: string; kind: 'expr' | 'str' | 'bool'; value: string }

/** Parse a component tag's attributes into prop={expr} / prop="lit" / bool. */
function parseCompAttrs(attrs: string): CompAttr[] {
  const out: CompAttr[] = [];
  let i = 0;
  while (i < attrs.length) {
    const nm = /^\s*([\w:.-]+)/.exec(attrs.slice(i));
    if (!nm) break;
    i += nm[0].length;
    const eq = /^\s*=\s*/.exec(attrs.slice(i));
    if (!eq) {
      out.push({ name: nm[1], kind: 'bool', value: '' });
      continue;
    }
    i += eq[0].length;
    const ch = attrs[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < attrs.length && depth > 0) {
        if (attrs[j] === '{') depth++;
        else if (attrs[j] === '}') depth--;
        j++;
      }
      out.push({ name: nm[1], kind: 'expr', value: attrs.slice(i + 1, j - 1).trim() });
      i = j;
    } else if (ch === '"' || ch === "'") {
      const j = attrs.indexOf(ch, i + 1);
      out.push({ name: nm[1], kind: 'str', value: attrs.slice(i + 1, j < 0 ? attrs.length : j) });
      i = j < 0 ? attrs.length : j + 1;
    } else break;
  }
  return out;
}

/**
 * Reject a slot= that hides inside a named slot's content. The child only
 * ever looks at its DIRECT named children, so `<span slot="a"><b slot="a">`
 * would silently drop the inner one - say it at build time instead. The walk
 * is quote-aware (scanTagEnd), so an attribute value containing '>' cannot
 * fake a tag.
 */
function rejectNestedSlot(src: string, outer: string): void {
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) return;
    const nm = /^<(\/?)([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 64));
    if (!nm) { i = lt + 1; continue; }
    const end = scanTagEnd(src, lt);
    if (end < 0) return;
    const hit = /\bslot\s*=\s*["'](\w+)["']/.exec(src.slice(lt, end));
    if (hit && nm[1] !== '/') {
      throw new Error(`slot="${hit[1]}" on <${nm[2]}> is nested inside slot="${outer}" - a slot must be a direct child of the component`);
    }
    i = end;
  }
}

/**
 * Split a component's children into the default slot and the named slots
 * (`<li slot="row">`). Only DIRECT children may be slot content: lifting an
 * element out of another element, or out of an {#if}/{#each} block, would
 * break the template around it - so that is a build error, not a silent
 * mis-render.
 */
function splitSlots(src: string): { def: string; named: Array<[string, string]> } {
  let def = '';
  const named = new Map<string, string>();
  let i = 0;
  let elemDepth = 0;
  let blockDepth = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const ob = src.indexOf('{#', i);
    const cb = src.indexOf('{/', i);
    const cands = [lt, ob, cb].filter((x) => x >= 0);
    if (cands.length === 0) {
      def += src.slice(i);
      break;
    }
    const next = Math.min(...cands);
    if (next > i) def += src.slice(i, next);
    if (next === ob || next === cb) {
      const close = src.indexOf('}', next);
      const token = src.slice(next, close < 0 ? src.length : close + 1);
      if (next === ob) blockDepth++;
      else blockDepth = Math.max(0, blockDepth - 1);
      def += token;
      i = next + token.length;
      continue;
    }
    const nm = /^<(\/?)([a-zA-Z][\w-]*)/.exec(src.slice(next, next + 64));
    if (!nm) {
      def += '<';
      i = next + 1;
      continue;
    }
    const end = scanTagEnd(src, next);
    if (end < 0) {
      def += src.slice(next);
      break;
    }
    const tagText = src.slice(next, end);
    const selfClosing = /\/>$/.test(tagText);
    const isVoid = VOID_TAGS.has(nm[2].toLowerCase());
    if (nm[1] === '/') {
      elemDepth = Math.max(0, elemDepth - 1);
      def += tagText;
      i = end;
      continue;
    }
    if (!selfClosing && !isVoid) elemDepth++;
    const slotName = /\bslot\s*=\s*["'](\w+)["']/.exec(tagText)?.[1];
    if (slotName && (elemDepth !== 1 || blockDepth !== 0)) {
      throw new Error(`slot="${slotName}" on <${nm[2]}> must be a direct child of the component - it is nested inside another element or an {#if}/{#each} block`);
    }
    if (slotName) {
      const stripped = tagText.replace(/\s*slot\s*=\s*["']\w+["']/, '');
      if (selfClosing || isVoid) {
        named.set(slotName, (named.get(slotName) ?? '') + stripped);
      } else {
        const closeIdx = findClose(src, end, nm[2]);
        if (closeIdx < 0) throw new Error(`unclosed <${nm[2]}> inside slot="${slotName}"`);
        const tail = `</${nm[2]}>`;
        const inner = src.slice(end, closeIdx);
        rejectNestedSlot(inner, slotName);
        named.set(slotName, (named.get(slotName) ?? '') + stripped + inner + tail);
        elemDepth = Math.max(0, elemDepth - 1);
        i = closeIdx + tail.length;
        continue;
      }
      i = end;
      continue;
    }
    def += tagText;
    i = end;
  }
  return { def, named: [...named.entries()] };
}

/** Emit a static chunk (attributes are handled by the expr branch). */
function emitChunk(text: string, acc: string, closes: string, scope: string | null): string {
  if (!text) return '';
  return `${acc} += ${JSON.stringify(text)};\n`;
}

const IMG_RE = /<img\b(?:[^<>]|\{[^{}]*\})*>/g;
const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const INLINE_IMG_MAX = 4096;

function inlineImages(template: string, publicDir: string): string {
  return template.replace(IMG_RE, (tag) => {
    const src = tag.match(/\bsrc="(\/[^"{}]+)"/);
    if (!src) return tag;
    const ext = path.extname(src[1]).toLowerCase();
    const mime = IMG_MIME[ext];
    if (!mime) return tag;
    let file: Buffer;
    try {
      file = fs.readFileSync(path.join(publicDir, src[1]));
    } catch {
      return tag;
    }
    if (file.length > INLINE_IMG_MAX) return tag;
    const uri = ext === '.svg'
      ? `data:image/svg+xml,${file.toString('utf-8').replace(/%/g, '%25').replace(/#/g, '%23').replace(/"/g, '%22')}`
      : `data:${mime};base64,${file.toString('base64')}`;
    return tag.replace(src[0], `src="${uri}"`);
  });
}

/**
 * Emit a reactive text marker through the runtime's textMark(): the helper
 * pushes the closure and returns the marker pair around the escaped value.
 * A marker whose value is followed by literal text passes pair, so the wire
 * can bound exactly the value and leave the prose alone.
 */
function emitText(expr: string, acc: string, closes: string, scope: string | null, markers = true, pair = false): string {
  if (!markers) {
    return `${acc} += esc(${expr});\n`;
  }
  const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
  let extra = pair ? ', 1' : scope ? ', 0' : '';
  if (scope) extra += `, ${scope}`;
  return `${acc} += textMark(${closes}, ${fn}${extra});\n`;
}

/** Emit a reactive attribute through the runtime's attrMark(). */
function emitAttr(attr: string, expr: string, acc: string, closes: string, scope: string | null, markers = true): string {
  if (!markers) {
    return `${acc} += '${attr}="' + esc(${expr}) + '"';\n`;
  }
  const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
  const arg = scope ? `, ${scope}` : '';
  return `${acc} += attrMark(${closes}, ${fn}, '${attr}'${arg});\n`;
}

/**
 * <slot /> -> inline the children html. The page rendered first with the same
 * shared closes array, so the top-level wire() pass resolves its markers.
 */
function compileSlot(acc: string): string {
  return `${acc} += String(children);\n`;
}

const RUNTIME_IMPORTS = `import { state, $data, hasState, esc, refresh, onMount, onCleanup, getContext, $t, bestLocale, localeDir, ensureLocale, loadLocale, handlers, $cookies, $sessionCookie, $store, ActionError, $actionError, $actionErrorOrThrow, $boundaryFallback, $append, $prepend, $merge, applyStateDeltas, textMark, attrMark, ifMark, eachMark, headMark } from './runtime.js';`;

/**
 * `export let title = 'x'` -> a per-invocation const read from the
 * caller's props object, defaulting to the declared value. Emitted at the top
 * of render(), BEFORE the state declarations: a prop may seed one
 * (`let open = $state(collapsed)`).
 */
function propsCode(props: Array<{ name: string; def: string | null }>): string {
  if (props.length === 0) return '';
  return props
    .map((p) => `const ${p.name} = __p.${p.name}${p.def ? ` ?? (${p.def})` : ''};`)
    .join('\n');
}

const SLOT_HELPER = `const __slot = (sl, name, pairs) => {
  const fn = sl[name];
  if (typeof fn !== 'function') return null;
  const o = {};
  for (let i = 0; i < pairs.length; i++) o[pairs[i][0]] = pairs[i][1];
  return { o, fn };
};
const __slotBlock = (closes, sl, name, pairs) => {
  const hit = __slot(sl, name, pairs);
  const idx = closes.length;
  closes.push(() => {
    if (!hit) return null;
    const c = [];
    return { html: String(hit.fn(hit.o, c)), closes: c, scope: hit.o };
  });
  return "<!--\\u27e6i:" + idx + "\\u27e7-->" + (hit ? String(hit.fn(hit.o, [])) : "") + "<!--\\u27e6/i:" + idx + "\\u27e7-->";
};`;

function generateSSR(script: string, templateFn: string, stateDeclsCode: string, exports = '', headFn = '', props: Array<{ name: string; def: string | null }> = [], namedSlots = false, imports = '', isComponent = false, guard = ''): string {
  const headCode = headFn
    ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
__html += headMark(closes, __head);`
    : '';
  return `
${RUNTIME_IMPORTS}

${imports}

${exports}
${guard}

${namedSlots ? SLOT_HELPER : ''}

export ${isComponent ? 'function' : 'async function'} render(closes, children, __props, __slots) {
  ${props.length > 0 ? 'const __p = __props || {};' : ''}
  ${namedSlots ? 'const __sl = __slots || {};' : ''}
  ${propsCode(props)}
  ${stateDeclsCode}
 // The incremental patches of the action that produced THIS response.
  ${isComponent ? '' : 'applyStateDeltas();'}
  ${script}
  const __root = (__c, children) => { let h = ''; ${templateFn} return h; };
  let __html = ${isComponent ? '' : 'await '}__root(closes, children);${headCode}
  return __html;
}
`;
}

function generateClient(
  script: string,
  templateFn: string,
  stateDeclsCode: string,
  eventBindings: Array<{ event: string; fn: string }>,
  exports = '',
  headFn = '',
  props: Array<{ name: string; def: string | null }> = [],
  namedSlots = false,
  imports = '',
  isComponent = false
): string {
  const handlerRegistry = eventBindings.length > 0
    ? `Object.assign(handlers, { ${eventBindings.map((b) => b.fn).join(', ')} });`
    : '';
  const headCode = headFn
    ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
__html += headMark(closes, __head);`
    : '';

  return `
${RUNTIME_IMPORTS}

${imports}

${exports}

${namedSlots ? SLOT_HELPER : ''}

export ${isComponent ? 'function' : 'async function'} render(closes, children, __props, __slots) {
  ${props.length > 0 ? 'const __p = __props || {};' : ''}
  ${namedSlots ? 'const __sl = __slots || {};' : ''}
  ${propsCode(props)}
  ${stateDeclsCode}
  ${script}
  ${handlerRegistry}
  const __root = (__c, children) => { let h = ''; ${templateFn} return h; };
  let __html = ${isComponent ? '' : 'await '}__root(closes, children);${headCode}
  return __html;
}
`;
}

/** The layout chain for a component (deepest first): every layout file in an
 *  ancestor directory. Shared by compose(), the zero-JS decision (#29) and
 *  the build report (#31). */
const layoutsOf = (infos: RouteInfo[], idx: number): number[] =>
  infos
    .map((li, i) => ({ li, i }))
    .filter(({ li }) => li.isLayout && isAncestorDir(li.filePath, infos[idx].filePath))
    .sort((a, b) => b.li.filePath.length - a.li.filePath.length)
    .map(({ i }) => i);

/**
 * 's decision as a pure function: does this route's document
 * ship without the client bundle? Shared by the route table (csr: false) and
 * the build report (#31), so the report can never disagree with the build.
 */
const routeShipsNoJs = (infos: RouteInfo[], compiled: CompileResult[], i: number): boolean => {
  if (compiled[i].csr === true) return false;
  if (compiled[i].needsClient) return false;
  return !layoutsOf(infos, i).some((li) => compiled[li].needsClient);
};

/**
 * The build's zero-JS lint report: one line per route with
 * its verdict and the exact reason - which component in the chain needs the
 * client bundle and why, or that nothing does. Pure: the same inputs the
 * route table is built from.
 */
export function buildReport(infos: RouteInfo[], compiled: CompileResult[]): string[] {
  return infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware && !info.isComponent)
     .map(({ info, i }) => {
      if (routeShipsNoJs(infos, compiled, i)) {
        return `${info.routePath}  zero-JS  nothing in the chain needs the client`;
      }
      const why = [i, ...layoutsOf(infos, i)]
        .filter((ci) => compiled[ci].needsClient)
        .map((ci) => `${(compiled[ci].clientReasons ?? ['needs the client']).join(' + ')} in ${path.basename(infos[ci].filePath)}`)
        .join('; ');
      const forced = compiled[i].csr === true ? ' (csr = true forces the bundle)' : '';
      return `${info.routePath}  client JS  ${why}${forced}`;
    });
}

export async function buildProject(root: string, outDir: string): Promise<{ routes: RouteInfo[]; bundle: string }> {
  await fs.promises.mkdir(outDir, { recursive: true });

  const stale = (await fs.promises.readdir(outDir)).filter((f) =>
    /^(?:comp-\d+\.(?:ssr|client)|runtime|(?:server|client)-entry)\.js$/.test(f));
  await Promise.all(stale.map((f) => fs.promises.rm(path.join(outDir, f), { force: true })));

  const pageFiles = await scanRoseFiles(root);
  const compFiles = await scanComponentFiles(root);
  const files = [...pageFiles, ...compFiles];
  if (pageFiles.length === 0) {
    throw new Error(`no .rose pages found under ${path.join(root, 'src', 'pages')} - run rosefd from a project root, or pass one: rosefd build <dir>`);
  }
  const infos = files.map((f) => ({ ...getRouteInfo(f, root) }));
  const config = await loadConfig(root);
  const plugins = config.plugins;
  const scopeKeys = files.map((f, i) => {
    const base = infos[i].isComponent ? path.join(root, 'src') : path.join(root, 'src', 'pages');
    return path.relative(base, f).replace(/\\/g, '/').replace(/\.rose$/, '');
  });
  const registry: RoseRegistry = new Map(
    files.map((f, i) => [f, { index: i, scopeKey: scopeKeys[i], slots: scanSlotDecls(f) }])
  );
  const compiled = await Promise.all(
    files.map((f, i) => compileComponent(f, path.join(root, 'public'), scopeKeys[i], infos[i].isApi, plugins, registry))
  );

  const importsOf = new Map<number, number[]>();
  files.forEach((_, i) => {
    const list: number[] = [];
    for (const r of compiled[i].roseImports ?? []) {
      const abs = path.resolve(path.dirname(files[i]), r.specifier);
      const hit = registry.get(abs);
      if (hit) list.push(hit.index);
    }
    importsOf.set(i, list);
  });
  const needyDep = (i: number, seen = new Set<number>()): string | null => {
    if (compiled[i].needsClient) return path.basename(files[i]);
    if (seen.has(i)) return null;
    seen.add(i);
    for (const dep of importsOf.get(i) ?? []) {
      const hit = needyDep(dep, seen);
      if (hit) return hit;
    }
    return null;
  };
  compiled.forEach((c, i) => {
    if (c.needsClient) return;
    const who = needyDep(i);
    if (who) {
      c.needsClient = true;
      c.clientReasons = [...(c.clientReasons ?? []), `imported component ${who} needs the client`];
    }
  });

  const reachable = new Set<number>();
  const visit = (i: number) => {
    if (reachable.has(i)) return;
    reachable.add(i);
    for (const r of compiled[i].roseImports ?? []) {
      const abs = path.resolve(path.dirname(files[i]), r.specifier);
      const hit = registry.get(abs);
      if (hit) visit(hit.index);
    }
  };
  files.forEach((_, i) => {
    if (!infos[i].isComponent) visit(i);
  });

  const styles = compiled
    .map((c, i) => (reachable.has(i) ? c.style : ''))
    .filter(Boolean).join('\n');
  if (styles) await fs.promises.writeFile(path.join(outDir, 'styles.css'), styles);
  else await fs.promises.rm(path.join(outDir, 'styles.css'), { force: true });

  let locales: Record<string, Record<string, string>> = {};
  try {
    for (const f of await fs.promises.readdir(path.join(root, 'src', 'locales'))) {
      if (!f.endsWith('.json')) continue;
      locales[f.slice(0, -5)] = JSON.parse(await fs.promises.readFile(path.join(root, 'src', 'locales', f), 'utf-8'));
    }
  } catch {
    locales = {};
  }
  const defaultLocale = locales.en ? 'en' : Object.keys(locales).sort()[0] ?? 'en';
  const localesJson = JSON.stringify(locales).replace(/</g, '\\u003c');

  const preload: string[] = config.i18n.preload ?? Object.keys(locales);
  const packed = Object.keys(locales).filter((l) => !preload.includes(l));
  for (const l of preload) {
    if (!locales[l]) console.warn(`Rose Frame Driver: i18n.preload lists '${l}' but there is no src/locales/${l}.json - ignored`);
  }
  await fs.promises.rm(path.join(outDir, 'locales'), { recursive: true, force: true });
  if (packed.length > 0) {
    const packDir = path.join(outDir, 'locales');
    await fs.promises.mkdir(packDir, { recursive: true });
    for (const l of packed) await fs.promises.writeFile(path.join(packDir, `${l}.json`), JSON.stringify(locales[l]));
  }
  const clientLocales = Object.fromEntries(Object.keys(locales).filter((l) => !packed.includes(l)).map((l) => [l, locales[l]]));
  const clientLocalesJson = JSON.stringify(clientLocales).replace(/</g, '\\u003c');

  const buildDir = path.join(outDir, '.build');
  await fs.promises.rm(buildDir, { recursive: true, force: true });
  await fs.promises.mkdir(buildDir, { recursive: true });

  const runtimePlugins = plugins.filter((p) => p && (p.onRequest || p.onResponse));
  if (runtimePlugins.length > 0) {
    const configRel = path.relative(buildDir, path.join(root, 'rosefd.config.js')).replace(/\\/g, '/');
    await fs.promises.writeFile(path.join(buildDir, 'plugins.js'), `    // Generated by rosefd - the runtime half of rosefd.config.js. Do not edit.
import config from ${JSON.stringify(configRel)};

const list = Array.isArray(config) ? config : [];
export const hooks = list
  .filter((p) => p && (p.onRequest || p.onResponse))
  .map((p) => ({ name: p.name, onRequest: p.onRequest ? p.onRequest.bind(p) : null, onResponse: p.onResponse ? p.onResponse.bind(p) : null }));

export const hasRequestHooks = hooks.some((p) => p.onRequest);
export const hasResponseHooks = hooks.some((p) => p.onResponse);
`);
  }

  const runtimeEntry = ['../runtime/index.ts', '../src/runtime/index.ts']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((p) => fs.existsSync(p));
  if (!runtimeEntry) throw new Error('Rose Frame Driver: the runtime source (src/runtime/index.ts) was not found next to the compiler');
  await esbuild.build({
    entryPoints: [runtimeEntry],
    bundle: true,
    outfile: path.join(buildDir, 'runtime.js'),
    format: 'esm',
    platform: 'browser',
    write: true,
  });

  for (let i = 0; i < compiled.length; i++) {
    const src = compiled[i].api ?? compiled[i].ssr;
    await fs.promises.writeFile(path.join(buildDir, `comp-${i}.ssr.js`), src);
    if (!infos[i].isApi) {
      await fs.promises.writeFile(path.join(buildDir, `comp-${i}.client.js`), compiled[i].client);
    }
  }

  const pages = infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware && !info.isComponent);

  const apiRoutes = infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => info.isApi);

  const compose = (idx: number): string => {
    let expr = `render_${idx}`;
    for (const i of layoutsOf(infos, idx)) {
      expr = `(async (closes, children) => await render_${i}(closes, await (${expr})(closes, children)))`;
    }
    return expr;
  };

  const bundleMode = compiled.find((c) => c.bundle)?.bundle ?? 'inline';
  const split = bundleMode === 'split';
  const chainOf = (idx: number): number[] => [idx, ...layoutsOf(infos, idx)];
  const loaderInner = (idx: number): string =>
    `load: () => loadChain([${chainOf(idx).map((i) => `() => import('./comp-${i}.client.js')`).join(', ')}])`;
  const loaderOf = (idx: number): string => `{ ${loaderInner(idx)} }`;

  const routeNoJs = (i: number): boolean => routeShipsNoJs(infos, compiled, i);

  const serverImports = compiled
    .map((_, i) => {
      if (!reachable.has(i)) return '';
      if (infos[i].isMiddleware) {
        return `import * as middlewareMod from './comp-${i}.ssr.js';`;
      }
      if (infos[i].isApi) {
        const names = compiled[i].apiMethods ?? [];
        const handlerImports = names.map((n) => `${n} as ${n}_${i}`).join(', ');
        return handlerImports
          ? `import { ${handlerImports} } from './comp-${i}.ssr.js';`
          : `import './comp-${i}.ssr.js';`;
      }
      const isPage = !infos[i].isLayout && !infos[i].isNotFound;
      const names = isPage ? compiled[i].actionNames : [];
      const actionImports = names.map((n) => `${n} as ${n}_${i}`).join(', ');
      const guardImport = isPage && compiled[i].guardName ? `beforeAction as beforeAction_${i}` : '';
      const named = [actionImports, guardImport].filter(Boolean).join(', ');
      return named
        ? `import { render as render_${i}, ${named} } from './comp-${i}.ssr.js';`
        : `import { render as render_${i} } from './comp-${i}.ssr.js';`;
    })
    .join('\n');

  const nfIdx = infos.findIndex((info) => info.isNotFound);
  const notFoundRender = nfIdx >= 0 ? (split ? loaderOf(nfIdx) : compose(nfIdx)) : 'null';

  const errIdx = infos.findIndex((info) => info.isError);
  const errorRender = errIdx >= 0 ? (split ? loaderOf(errIdx) : compose(errIdx)) : 'null';

  const middlewareIdx = infos.findIndex((info) => info.isMiddleware);

  const serverRoutes = pages
    .map(({ info, i }) => {
      const actionMap = compiled[i].actionNames.map((n) => `${n}: ${n}_${i}`).join(', ');
      if (compiled[i].csr === false && compiled[i].needsClient) {
        throw new Error(
          `${info.filePath}: csr = false but this route needs the client bundle ` +
          `(${(compiled[i].clientReasons ?? ['needs the client']).join(' + ')}).`
        );
      }
      if (compiled[i].csr === false) {
        const needy = layoutsOf(infos, i).find((li) => compiled[li].needsClient);
        if (needy !== undefined) {
          throw new Error(
            `${info.filePath}: csr = false cannot ship under ${infos[needy].filePath} - the layout needs the client bundle ` +
            `(event wiring, onMount/onCleanup, refresh() or a server action).`
          );
        }
      }
      const csrFlag = routeNoJs(i) ? ', csr: false' : '';
      const guardFlag = compiled[i].guardName ? `, guard: beforeAction_${i}` : '';
      return `{ pattern: '${info.pattern}', path: '${info.routePath}', render: ${compose(i)}, actions: ${actionMap ? `{ ${actionMap} }` : 'null'}${guardFlag}${csrFlag} }`;
    })
    .join(',\n  ');

  const serverEntry = `
${serverImports}
import { setState, clearRequestState, serializeState, resetRequestContext, isLocale, setLocales, localeList, localeDir, setStoreTransport, applyStorePatch, ActionError, StateDelta, setStateDelta } from './runtime.js';
${runtimePlugins.length > 0
    ? `import { hooks as __pluginHooks, hasRequestHooks as __hasRequestHooks, hasResponseHooks as __hasResponseHooks } from './plugins.js';`
: `// no plugin declares a runtime hook, so there is no plugins
// module to import - the runners below stay no-ops and the servers call them
// unconditionally (one code path, no flags to keep in sync).
const __pluginHooks = [];
const __hasRequestHooks = false;
const __hasResponseHooks = false;`}

// The runtime plugin hooks.
export async function runRequestHooks(ctx) {
  for (const p of __pluginHooks) {
    if (!p.onRequest) continue;
    try {
      const r = await p.onRequest(ctx);
      if (r instanceof Response) return r;
    } catch (err) {
      console.error('Rose Frame Driver: plugin', p.name, 'onRequest failed:', err instanceof Error ? err.message : err);
    }
  }
  return null;
}

export async function runResponseHooks(ctx, res) {
  let out = res;
  for (const p of __pluginHooks) {
    if (!p.onResponse) continue;
    try {
      const r = await p.onResponse(ctx, out);
      if (r instanceof Response) out = r;
    } catch (err) {
      console.error('Rose Frame Driver: plugin', p.name, 'onResponse failed:', err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// The servers read these to skip building the hook context entirely when no
// hook exists - the hot path pays nothing for the feature.
export const hasRequestHooks = __hasRequestHooks;
export const hasResponseHooks = __hasResponseHooks;

// I18n: the dictionaries baked at build time from src/locales/*.json.
setLocales(${localesJson}, '${defaultLocale}');

// The store transport.
if (typeof process !== 'undefined' && typeof process.send === 'function') {
  setStoreTransport((name, value) => process.send({ type: 'rosefd:store', name, value }));
  process.on('message', (msg) => {
    if (msg && msg.type === 'rosefd:store') applyStorePatch(msg.name, msg.value);
  });
}

export { localeList };
export const defaultLocale = '${defaultLocale}';

// Route params maps, re-exported for the build's prerender step: routePath -> the component's exported params (a static map or a function).
${pages.filter(({ i }) => compiled[i].hasParams).map(({ i }) => `import * as comp_${i} from './comp-${i}.ssr.js';`).join('\n')}

export const routeParams = {
  ${pages.filter(({ info, i }) => compiled[i].hasParams).map(({ info, i }) => `'${info.routePath}': comp_${i}.params`).join(',\n  ')}
};

// Routes whose component reads the request context (getContext()), mutates a shared store ($store)
export const dynamicRoutes = [
  ${pages.filter(({ i }) => compiled[i].usesContext || compiled[i].cspNonce).map(({ info }) => `'${info.routePath}'`).join(',\n  ')}
];

// Which api routes opt into build-time baking (export const prerender = true): routePath -> boolean.
${apiRoutes.filter(({ i }) => compiled[i].hasPrerender).map(({ i }) => `import * as api_${i} from './comp-${i}.ssr.js';`).join('\n')}

export const apiPrerender = {
  ${apiRoutes.map(({ info, i }) => `'${info.routePath}': ${compiled[i].hasPrerender ? `api_${i}.prerender === true` : 'false'}`).join(',\n  ')}
};

// Stale-while-revalidate windows (export const revalidate = N): the build bakes these routes like any other.
export const revalidate = [
  ${pages.filter(({ i }) => compiled[i].revalidate !== undefined && !compiled[i].usesContext).map(({ info, i }) => `{ pattern: '${info.pattern}', seconds: ${compiled[i].revalidate} }`).join(',\n  ')}
];

// Pages/_middleware.rose: a Web-standard request handler that runs before every render on the server (pages, POSTs, api calls alike).
export const middleware = ${middlewareIdx >= 0 ? 'middlewareMod.handle ?? null' : 'null'};

// Routes whose DOCUMENTS ship without the client bundle ( decided by the compiler since #29): HTML + CSS only - no runtime, no state script.
export const noJsRoutes = [
  ${pages.filter(({ i }) => routeNoJs(i)).map(({ info }) => `'${info.pattern}'`).join(',\n  ')}
];

export function isNoJs(pathname) {
  return noJsRoutes.some((pattern) => matchRoute(pattern, pathname));
}

// Per-route response headers: a route exporting a headers map carries them into every response the servers write.
export const routeHeaders = [
  ${pages.filter(({ i }) => compiled[i].headers).map(({ info, i }) => `{ pattern: '${info.pattern}', headers: ${JSON.stringify(compiled[i].headers)} }`).join(',\n  ')}
];

export function headersFor(pathname) {
  const hit = routeHeaders.find((r) => matchRoute(r.pattern, pathname));
  return hit ? hit.headers : null;
}

// Routes that opted into nonce-based CSP (export const csp = { nonce: true }, ).
export const cspNonceRoutes = [
  ${pages.filter(({ i }) => compiled[i].cspNonce).map(({ info }) => `'${info.routePath}'`).join(',\n  ')}
];

export function cspNonce(pathname) {
  return cspNonceRoutes.some((pattern) => matchRoute(pattern, pathname));
}

// A Web-standard Request from whatever the host provides: the edge adapter passes one already; the Node server passes its IncomingMessage (plus).
function toWebRequest(raw, form) {
  if (raw instanceof Request) return raw;
  const init = { method: raw.method || 'GET', headers: new Headers(raw.headers || {}) };
  if (form) init.body = form;
  return new Request('http://' + (raw.headers?.host || 'localhost') + (raw.url || '/'), init);
}

// Runs the middleware (if the project has one) for this request and returns its short-circuit Response, or null to continue.
export async function runMiddleware(rawReq, form) {
  resetRequestContext();
  if (!middleware || !rawReq) return null;
  const res = await middleware(toWebRequest(rawReq, form));
  return res || null;
}

const routes = [
  ${serverRoutes}
];

// API routes (pages/api/*.rose): pattern -> HTTP-method handlers. They never render HTML and never reach the client bundle.
const apiRoutes = [
  ${apiRoutes.map(({ info, i }) => {
    const handlers = (compiled[i].apiMethods ?? []).map((n) => `${n}: ${n}_${i}`).join(', ');
    return `{ pattern: '${info.pattern}', path: '${info.routePath}', handlers: { ${handlers} } }`;
  }).join(',\n  ')}
];

// pages/404.rose (with its layouts) or null -> built-in plain 404
const notFound = ${notFoundRender};

// pages/500.rose (with its layouts) or null -> built-in plain 500: a route
// whose render throws degrades to this instead of failing the response.
const errorPage = ${errorRender};

// The <html> attributes of the document for a pathname - the locale of its [lang] segment (the default when there is none).
export function docAttrs(pathname) {
  for (const route of routes) {
    if (!matchRoute(route.pattern, pathname)) continue;
    const parts = route.pattern.split('/');
    const langIdx = parts.indexOf(':lang');
    if (langIdx >= 0) {
      const lang = pathname.split('/')[langIdx];
      if (isLocale(lang)) return { lang, dir: localeDir(lang) };
    }
    break; // matched, but not a localized route (or a bogus locale): the default
  }
  return { lang: defaultLocale, dir: localeDir(defaultLocale) };
}

// Paint a fallback page (404/500) and serialize its state.
async function renderFallback(pathname, render) {
  const { html, head } = extractHead(await render([], ''));
  const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
  return { html, state, head, ...docAttrs(pathname) };
}

export function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

// Head blocks (one per component in the route chain) are pulled out of the page html: the shell injects them into <head>.
function extractHead(rendered) {
  const head = [];
  const html = rendered.replace(/<!--\u27e6h:(\\d+)\u27e7-->([\\s\\S]*?)<!--\u27e6\\/h:\\1\u27e7-->/g, (_, id, content) => {
    head.push(content);
    return '<!--\u27e6h:' + id + '\u27e7--><!--\u27e6/h:' + id + '\u27e7-->';
  });
  return { html, head };
}

// Form: the submitted FormData of a progressive-enhancement POST.
export async function renderPage(pathname, form) {
  clearRequestState();
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      const patternParts = route.pattern.split('/');
      const pathParts = pathname.split('/');
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          setState(patternParts[i].slice(1), pathParts[i]);
        }
      }
 // I18n: a [lang] segment naming no dictionary is a 404 - the URL is the contract.
      const langIdx = patternParts.indexOf(':lang');
      if (langIdx >= 0 && !isLocale(pathParts[langIdx])) {
        if (notFound) return { ...(await renderFallback(pathname, notFound)), status: 404 };
        return { html: '<h1>404</h1><p>Page not found</p>', state: '{}', head: [], status: 404, ...docAttrs(pathname) };
      }
 // The document's <html lang>/<dir> follow this route's locale
      // (the default's when the route is not localized)
      const docLang = langIdx >= 0 ? pathParts[langIdx] : defaultLocale;
 // The action dispatch. The page's guard (exported beforeAction) runs FIRST and vetoes with an ActionError - the action-level permission check.
      let actionStatus = 0;
      if (form && route.actions) {
        const actionName = form.get('__action') || 'action';
        const fn = route.actions[actionName];
        if (fn) {
          try {
            if (route.guard) await route.guard(actionName, form);
            const patch = await fn(form);
            if (patch && typeof patch === 'object') {
              for (const key of Object.keys(patch)) {
                const v = patch[key];
                // An incremental patch is RECORDED, not applied: the render's own state declarations apply.
                if (v instanceof StateDelta) setStateDelta(key, v);
                else setState(key, v);
              }
            }
          } catch (err) {
            if (err instanceof ActionError) {
              setState('actionError', { action: actionName, message: err.message, code: err.code, field: err.field });
              actionStatus = err.code;
            } else {
              throw err;
            }
          }
        }
      }
      let rendered;
      try {
        rendered = extractHead(await route.render([], ''));
      } catch (err) {
        console.error('Rose Frame Driver: render failed for', pathname, err instanceof Error ? err.message : err);
        if (errorPage) return { ...(await renderFallback(pathname, errorPage)), status: 500 };
        return { html: '<h1>500</h1><p>Something went wrong rendering this page.</p>', state: '{}', head: [], status: 500, ...docAttrs(pathname) };
      }
      // __route tells the bootstrap which route this document was rendered for.
      const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
 // Csr ( auto since #29): false when the compiler found nothing in the route's chain that needs the client (or the route asserted csr = false) .
      return { html: rendered.html, state, head: rendered.head, status: actionStatus || 200, csr: route.csr !== false, lang: docLang, dir: localeDir(docLang) };
    }
  }
  if (notFound) {
    return { ...(await renderFallback(pathname, notFound)), status: 404 };
  }
  return { html: '<h1>404</h1><p>Page not found</p>', state: '{}', head: [], status: 404, ...docAttrs(pathname) };
}

// Would renderPageStream handle this path? (matched route = stream, anything
// else = buffered 404/500). Lets the servers pick the path before headers.
export function canStream(pathname) {
  return routes.some((route) => {
    if (!matchRoute(route.pattern, pathname)) return false;
 // I18n: an unknown locale must answer 404, and a streamed response cannot change its status - so it takes the buffered path (renderPage returns).
    const langIdx = route.pattern.split('/').indexOf(':lang');
    return langIdx < 0 || isLocale(pathname.split('/')[langIdx]);
  });
}

// === API routes === The /api namespace answers JSON, never HTML: an API client that hits an unknown path must not receive the SPA shell.
export function isApi(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function toResponse(out) {
  if (out instanceof Response) return out;
  if (out === undefined || out === null) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleApi(method, pathname, request) {
  for (const route of apiRoutes) {
    if (matchRoute(route.pattern, pathname)) {
      const fn = route.handlers[method];
      if (!fn) {
        return new Response(JSON.stringify({ error: 'method not allowed' }), {
          status: 405,
          headers: { 'content-type': 'application/json', allow: Object.keys(route.handlers).join(', ') },
        });
      }
      return toResponse(await fn(request));
    }
  }
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

// === Streaming SSR === The static shell (doctype, <head>, body + container open) flushes BEFORE the - possibly slow - render completes: the first byte.
export async function renderPageStream(pathname, write, shellOpen, clientTag) {
  clearRequestState();
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      const patternParts = route.pattern.split('/');
      const pathParts = pathname.split('/');
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          setState(patternParts[i].slice(1), pathParts[i]);
        }
      }
      // i18n: an unknown locale must 404 BEFORE the shell flushes - a
      // streamed response cannot change its status afterwards
      const langIdx = patternParts.indexOf(':lang');
      if (langIdx >= 0 && !isLocale(pathParts[langIdx])) return 404;
      write(shellOpen);
      let html;
      try {
        html = extractHead(await route.render([], '')).html;
      } catch (err) {
        // The shell is already on the wire: degrade to the error page BODY (the status stays 200 - a real 500 needs the buffered path).
        console.error('Rose Frame Driver: render failed for', pathname, err instanceof Error ? err.message : err);
        html = errorPage ? extractHead(await errorPage([], '')).html : '<h1>500</h1><p>Something went wrong rendering this page.</p>';
      }
      write(html);
 // Csr: false ( auto since #29): a no-JS route's document ends here - no state script, no inlined bundle.
      if (route.csr === false) {
        write('</div>\\n</body>\\n</html>');
        return 200;
      }
      const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
      write('</div>\\n  <script type="application/json" id="__rosefd_state">' + state + '</script>\\n  ' + clientTag + '\\n</body>\\n</html>');
      return 200;
    }
  }
  return 404;
}
`;
  await fs.promises.writeFile(path.join(buildDir, 'server-entry.js'), serverEntry);
  await esbuild.build({
    entryPoints: [path.join(buildDir, 'server-entry.js')],
    bundle: true,
    outfile: path.join(outDir, 'server.js'),
    format: 'esm',
    platform: 'node',
    write: true,
    ...TS_LOADER,
  });

  const clientImports = split ? '' : compiled
    .map((_, i) => ({ i }))
    .filter(({ i }) => !infos[i].isApi && !infos[i].isMiddleware && reachable.has(i))
    .map(({ i }) => `import { render as render_${i} } from './comp-${i}.client.js';`)
    .join('\n');

  const clientRoutes = pages
    .map(({ info, i }) => (split
      ? `{ pattern: '${info.pattern}', ${loaderInner(i)} }`
      : `{ pattern: '${info.pattern}', render: ${compose(i)} }`))
    .join(',\n  ');

  const prefetchMode = compiled.find((c) => c.prefetch)?.prefetch ?? 'all';

  const hasLang = infos.some((i) => i.pattern.includes(':lang'));
  const langDirBlock = hasLang
    ? ` // <html lang dir> follows the route - the one part of the document. client-side navigation cannot leave stale (screen readers and CSS. logical).
      const seg = langIdx >= 0 ? pathname.split('/')[langIdx] : '';
      const known = !seg || isLocale(seg);
      const docLang = known && seg ? seg : __defLocale;
      document.documentElement.lang = docLang;
      const docDir = localeDir(docLang);
      if (docDir) document.documentElement.setAttribute('dir', docDir);
      else document.documentElement.removeAttribute('dir');
      if (!known) {`
    : `      if (langIdx >= 0 && !isLocale(pathname.split('/')[langIdx])) {`;

  const clientEntry = `
${clientImports}
import { setState, resumeState, clearRequestState, resetEffects, wire, isolateStateAsync, restoreState, setRefreshHook, clearMounts, flushMounts, adoptCleanups, handlers, setLocales, setLocalePacks, ensureLocale, isLocale, localeDir } from './runtime.js';

// I18n: the dictionaries baked at build time - the client renders any PRELOADED locale from the bundle.
setLocales(${clientLocalesJson}, '${defaultLocale}');
setLocalePacks(${JSON.stringify(packed)});
${hasLang ? `// the default locale, kept beside setLocales' own copy so <html lang> can
// follow a route that carries no [lang] segment (a non-i18n page)
const __defLocale = '${defaultLocale}';` : ''}
// The two pack doors, re-exported for an app that wants to warm a language before its visitor asks for it (ensureLocale) or to feed a dictionary.
export { ensureLocale, loadLocale } from './runtime.js';

const routes = [
  ${clientRoutes}
];

// === Mode B: lazy route chunks === Split mode's registry entries arrive without a render function: loadChain loads the route's module graph (the page).
const loadChain = async (loaders) => {
  const mods = await Promise.all(loaders.map((load) => load()));
  let expr = (closes, children) => mods[0].render(closes, children);
  for (let k = 1; k < mods.length; k++) {
    const inner = expr;
    const outer = mods[k].render;
    expr = async (closes, children) => await outer(closes, await inner(closes, children));
  }
  return { render: expr };
};
const getRender = async (route) => {
  if (typeof route === 'function') return route; // inline mode: the render itself
  return (route.render ??= (await route.load()).render);
};

// pages/404.rose (with its layouts) or null -> built-in plain 404
const notFound = ${notFoundRender};

// Pages/500.rose (with its layouts) or null -> built-in plain 500: a route whose render throws on the client degrades to this instead of breaking.
const errorPage = ${errorRender};

// Paint a fallback page (404/500) into the container, wired like any render.
async function paintFallback(container, page, builtin) {
  resetEffects();
  clearRequestState();
  clearMounts(); // a failed render leaves stale mounts behind
  // inline mode passes the render itself; split mode passes a loader
  const render = page ? await getRender(page) : null;
  if (render) {
    const closes = [];
    const html = await render(closes, '');
    container.innerHTML = html;
    wire(container, closes);
    bindEvents(container);
    flushMounts();
    return;
  }
  container.innerHTML = builtin;
}

export function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

// === Link prefetch === Hover / focus / touch an internal link and the target route renders NOW - $data included - against a throwaway signal map.
let prefetchMode = ${JSON.stringify(prefetchMode)};
export function setPrefetchMode(mode) { prefetchMode = mode; }
const PREFETCH_BUDGET = 8;
const PREFETCH_MAX_CACHED = 4;
const prefetchCache = new Map(); // pathname -> { html, closes, state } | Promise
let prefetchQueue = Promise.resolve();
let prefetchPending = 0;

// Applies the route's params to state.
async function applyParams(route, pathname) {
  const patternParts = route.pattern.split('/');
  const pathParts = pathname.split('/');
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) setState(patternParts[i].slice(1), pathParts[i]);
  }
  const langIdx = patternParts.indexOf(':lang');
  if (langIdx >= 0) await ensureLocale(pathParts[langIdx]);
}

export function prefetch(pathname, source = 'hover') {
  if (prefetchMode === 'off') return;
  if (prefetchMode === 'hover' && source !== 'hover') return;
  if (prefetchMode === 'viewport' && source !== 'viewport') return;
  if (prefetchCache.has(pathname)) return;
  if (pathname === location.pathname) return; // already here: nothing to prefetch
  const route = routes.find((r) => matchRoute(r.pattern, pathname));
  if (!route) return;
  if (prefetchPending >= PREFETCH_BUDGET) return; // budget spent: drop it, a later hover retries
  const p = prefetchQueue.then(async () => {
    try {
      // The isolated render also captures the onMount callbacks the route queued and the onCleanup disposers it registered: the paint that consumes.
      const { result, state, mounts, cleanups } = await isolateStateAsync(async () => {
        await applyParams(route, pathname); // a packed locale's dictionary lands before the render
        const closes = [];
        const render = await getRender(route); // split mode: loads the route's chunk here
        const html = await render(closes, '');
        return { html, closes };
      });
      const entry = { ...result, state, mounts, cleanups };
      prefetchCache.set(pathname, entry); // Promise -> result. evict oldest-first; in-flight promises are never evicted (evicting. one would only force a duplicate render)
      while (prefetchCache.size > PREFETCH_MAX_CACHED) {
        const oldest = prefetchCache.keys().next().value;
        if (prefetchCache.get(oldest) instanceof Promise) break;
        prefetchCache.delete(oldest);
      }
      return entry;
    } catch {
      prefetchCache.delete(pathname); // failed: the next hover retries
      return null;
    } finally {
      prefetchPending--;
    }
  });
  prefetchPending++;
  prefetchCache.set(pathname, p);
  prefetchQueue = p;
}

export function prefetchStats() {
  return { cached: prefetchCache.size, pending: prefetchPending, mode: prefetchMode };
}

// One delegated listener per event type on the app container: survives DOM swaps and cloned blocks, so handlers never need re-binding.
const DELEGATED = ['click', 'input', 'change', 'submit'];
function bindEvents(container) {
  if (container.__rosefd_bound) return;
  container.__rosefd_bound = true;
  for (const ev of DELEGATED) {
    container.addEventListener(ev, (e) => {
      const el = e.target.closest('[data-on-' + ev + ']');
      if (!el || !container.contains(el)) return;
      const fn = el.getAttribute('data-on-' + ev);
      if (fn.startsWith('$action:')) return $action(fn.slice(8), e);
      const h = handlers[fn];
      if (h) h(e);
    });
  }
}

// === Server actions from any event === POST the body to the current route and adopt the response in place: the server runs the selected action.
async function postForm(body) {
  const res = await fetch(location.pathname, { method: 'POST', body });
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const next = doc.getElementById('app');
  const st = doc.getElementById('__rosefd_state');
  const paint = () => {
    const container = document.getElementById('app');
    adopt(container, next ? next.innerHTML : '', st ? st.textContent : '{}');
  };
  if (document.startViewTransition) document.startViewTransition(paint);
  else paint();
}

// Call a page's server action by name from any event handler: <button on:click={like}> compiles to $action('like').
export async function $action(name, e) {
  if (e && e.preventDefault) e.preventDefault();
  const body = new FormData();
  body.append('__action', name);
  return postForm(body);
}

export { postForm };

// Initial=true: adopt the SSR DOM (zero hydration) - wire reactive markers to the existing nodes and bind events.
export async function start(container, pathname, initial) {
  clearMounts(); // stale mounts from a failed render never fire
  if (initial) {
    const el = document.getElementById('__rosefd_state');
    if (el) resumeState(el.textContent);
  }
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      // I18n: an unknown locale paints the 404 page, same as the server (before the prefetch check: a cached entry for a bogus locale is discarded).
      const langIdx = route.pattern.split('/').indexOf(':lang');
${langDirBlock}
        await paintFallback(container, notFound, '<h1>404</h1><p>Page not found</p>');
        return;
      }
      // Prefetched on hover/focus/touch: the render already ran, so paint its HTML and adopt its signal entries - events then patch the very nodes we.
      let hit = initial ? undefined : prefetchCache.get(pathname);
      if (hit && typeof hit.then === 'function') hit = await hit; // in-flight: land it first
      if (hit) {
        prefetchCache.delete(pathname); // single-use: the next hover refetches
        resetEffects();
        restoreState(hit.state);
        container.innerHTML = hit.html;
        wire(container, hit.closes);
        bindEvents(container);
        hit.mounts.forEach((fn) => fn()); // the prefetched route's mounts
        adoptCleanups(hit.cleanups); // and its cleanups, for the next resetEffects
        return;
      }
      if (!initial) {
        resetEffects();
        clearRequestState();
      }
      await applyParams(route, pathname);
      const closes = [];
      let html;
      try {
        const render = await getRender(route); // split mode: loads the route's chunk here
        html = await render(closes, '');
      } catch {
        // the route itself is broken: degrade to pages/500.rose (or the
        // built-in plain 500) instead of leaving the container empty
        await paintFallback(container, errorPage, '<h1>500</h1><p>Something went wrong rendering this page.</p>');
        return;
      }
      if (!initial) container.innerHTML = html;
      wire(container, closes);
      bindEvents(container);
      flushMounts();
      return;
    }
  }
  // Unmatched route: pages/404.rose renders (with its head + interactivity)
${hasLang ? `  document.documentElement.lang = __defLocale;
  document.documentElement.removeAttribute('dir');` : ''}
  await paintFallback(container, notFound, '<h1>404</h1><p>Page not found</p>');
}

// Adopt a server-rendered response in place - the JS-enabled half of progressive-enhancement forms: the bootstrap POSTs a <form method="POST">.
export async function adopt(container, html, stateJson) {
  resetEffects();
  clearRequestState();
  clearMounts(); // stale mounts from a failed render never fire
  resumeState(stateJson);
  container.innerHTML = html;
  // keep the embedded state in sync so a later SPA-fallback check agrees
  const st = document.getElementById('__rosefd_state');
  if (st) st.textContent = stateJson;
  for (const route of routes) {
    if (matchRoute(route.pattern, location.pathname)) {
      await applyParams(route, location.pathname);
      const closes = [];
      try {
        const render = await getRender(route); // split mode: loads the route's chunk here
        await render(closes, '');
      } catch {
        // the adopted response's route is broken (e.g. the action's page
        // throws): keep the swapped DOM but skip wiring it
        return;
      }
      wire(container, closes);
      bindEvents(container);
      flushMounts();
      return;
    }
  }
}
// === refresh() implementation === Re-render the current route in place: the client half of router.refresh() a router refresh / a full invalidation.
setRefreshHook(async () => {
  prefetchCache.delete(location.pathname);
  await start(document.getElementById('app'), location.pathname, false);
});
`;
  await fs.promises.writeFile(path.join(buildDir, 'client-entry.js'), clientEntry);
  if (split) {
    await fs.promises.rm(path.join(outDir, 'chunks'), { recursive: true, force: true });
    await esbuild.build({
      entryPoints: [path.join(buildDir, 'client-entry.js')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      minify: true,
      splitting: true,
      outdir: outDir,
      entryNames: 'client',
      chunkNames: 'chunks/[name]-[hash]',
      write: true,
      ...TS_LOADER,
    });
  } else {
    await esbuild.build({
      entryPoints: [path.join(buildDir, 'client-entry.js')],
      bundle: true,
      outfile: path.join(outDir, 'client.js'),
      format: 'esm',
      platform: 'browser',
      minify: true,
      write: true,
      ...TS_LOADER,
    });
  }

  await fs.promises.rm(buildDir, { recursive: true, force: true });

  const publicDir = path.join(root, 'public');
  if (fs.existsSync(publicDir)) {
    const outPublic = path.join(outDir, 'public');
    await fs.promises.mkdir(outPublic, { recursive: true });
    const assets = await fs.promises.readdir(publicDir);
    await Promise.all(
      assets.map((a) => fs.promises.copyFile(path.join(publicDir, a), path.join(outPublic, a)))
    );
  }

  console.log('Rose Frame Driver zero-JS report:');
  for (const line of buildReport(infos, compiled)) console.log('  ' + line);
  for (const { info, i } of pages) {
    if (!routeShipsNoJs(infos, compiled, i)) continue;
    for (const ci of [i, ...layoutsOf(infos, i)]) {
      for (const w of compiled[ci].jsWarnings ?? []) {
        console.warn(`Rose Frame Driver warning: ${info.routePath} ships zero JavaScript but ${path.basename(infos[ci].filePath)} contains ${w}`);
      }
    }
  }

  return { routes: pages.map(({ info }) => info), bundle: bundleMode };
}

/** Every .rose file under <root>/src/pages, recursively (layouts and api included). */
export async function scanRoseFiles(root: string): Promise<string[]> {
  const pagesDir = path.join(root, 'src', 'pages');
  if (!fs.existsSync(pagesDir)) return [];

  async function scan(dir: string): Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await scan(full)));
      else if (entry.name.endsWith('.rose')) files.push(full);
    }
    return files;
  }

  return scan(pagesDir);
}

/** Every .rose file under <root>/src/components, recursively . These
 *  are not routes: they are compiled into the same module index space as the
 *  pages so a page can `import Card from '../components/Card.rose'`. */
export async function scanComponentFiles(root: string): Promise<string[]> {
  const compDir = path.join(root, 'src', 'components');
  if (!fs.existsSync(compDir)) return [];

  async function scan(dir: string): Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await scan(full)));
      else if (entry.name.endsWith('.rose')) files.push(full);
    }
    return files;
  }

  return scan(compDir);
}

function isAncestorDir(layoutPath: string, pagePath: string): boolean {
  const layoutDir = path.dirname(layoutPath);
  const pageDir = path.dirname(pagePath);
  return pageDir === layoutDir || pageDir.startsWith(layoutDir + path.sep);
}

function getRouteInfo(filePath: string, root: string): RouteInfo {
  const pagesDir = path.join(root, 'src', 'pages');
  const relative = path.relative(pagesDir, filePath).replace(/\\/g, '/');
  const withoutExt = relative.replace(/\.rose$/, '');
  const base = path.posix.basename(withoutExt);
  const isComponent = filePath.replace(/\\/g, '/').includes('/src/components/');
  const isLayout = !isComponent && base === '_layout';
  const isNotFound = !isComponent && base === '404';
  const isError = !isComponent && base === '500';
  const isApi = !isComponent && (withoutExt === 'api' || withoutExt.startsWith('api/'));
  const isMiddleware = !isComponent && withoutExt === '_middleware';

  let parts = withoutExt.split('/').filter((p) => p !== '_layout');
  if (parts.length > 1 && parts[parts.length - 1] === 'index') parts = parts.slice(0, -1);
  const routeParts = parts.map((part) =>
    part.startsWith('[') && part.endsWith(']') ? `:${part.slice(1, -1)}` : part
  );

  let routePath: string;
  if (routeParts.length === 0 || (routeParts.length === 1 && routeParts[0] === 'index')) {
    routePath = '/';
  } else {
    routePath = '/' + routeParts.join('/');
  }

  return {
    filePath,
    routePath,
    pattern: routePath,
    paramNames: parts.filter((p) => p.startsWith('[') && p.endsWith(']')).map((p) => p.slice(1, -1)),
    isLayout,
    isNotFound,
    isError,
    isApi,
    isMiddleware,
    isComponent,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
