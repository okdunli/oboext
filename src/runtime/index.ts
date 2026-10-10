// rosezm Runtime - Zero-hydration, compile-time reactivity Target: < 2KB gzipped

type Subscriber = () => void;
type Cleanup = () => void;
type SignalEntry = { value: unknown; subs: Set<Subscriber> };

let currentEffect: (() => void) | null = null;

let signalMap: Map<string, SignalEntry> =
  (globalThis as any).__rosezm_signalMap ?? new Map();
(globalThis as any).__rosezm_signalMap = signalMap;

function entry(key: string, initial: unknown): { value: unknown; subs: Set<Subscriber> } {
  const e = signalMap.get(key) ?? { value: initial, subs: new Set<Subscriber>() };
  signalMap.set(key, e);
  return e;
}

export function state<T>(key: string, initial: T): [() => T, (v: T) => void] {
  const e = entry(key, initial);

  const getter = () => {
    if (currentEffect) e.subs.add(currentEffect);
    return e.value as T;
  };

  const setter = (v: T) => {
    e.value = v;
    e.subs.forEach((fn: Subscriber) => fn());
  };

  return [getter, setter];
}

export function hasState(key: string): boolean {
  return signalMap.has(key);
}

export function setState<T>(key: string, value: T): void {
  const e = entry(key, value);
  e.value = value;
  e.subs.forEach((fn: Subscriber) => fn());
}

const cleanups = new Set<Cleanup>();

export function effect(fn: () => void): Cleanup {
  const wrapped: Subscriber = () => {
    try {
      fn();
    } catch {
      // subscriber may be stale; ignore
    }
  };
  const prev = currentEffect;
  currentEffect = wrapped;
  fn();
  currentEffect = prev;
  const cleanup: Cleanup = () => {
    signalMap.forEach((e: { subs: Set<Subscriber> }) => e.subs.delete(wrapped));
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  return cleanup;
}

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

const MARK_RE = /^\u27e6([milh]):(\d+)\u27e7$/;
const END_RE = /^\u27e6\/([ilh]):(\d+)\u27e7$/;

const wired = new WeakSet<Node>();

/** Parse an html string into a DocumentFragment. */
export function tpl(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

const HEAD_ATTR = 'data-rosezm-head';

// Apply one rendered <head> block to the document: <title> replaces the title.
export function applyHead(html: string, provided: Set<string>): void {
  const frag = tpl(html);
  for (const el of Array.from(frag.children)) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'title') {
      let titleEl = document.head.querySelector('title');
      if (!titleEl) {
        titleEl = document.createElement('title');
        document.head.appendChild(titleEl);
      }
      titleEl.textContent = el.textContent ?? '';
      continue;
    }
    if (tag !== 'meta' && tag !== 'link' && tag !== 'base') continue;
    const key = el.getAttribute('name')
      ?? el.getAttribute('property')
      ?? el.getAttribute('rel')
      ?? el.getAttribute('charset');
    if (!key) continue;
    const managed = `${tag}:${key}`;
    provided.add(managed);
    let target = document.head.querySelector(`[${HEAD_ATTR}="${managed}"]`);
    if (!target) {
      target = document.createElement(tag);
      target.setAttribute(HEAD_ATTR, managed);
      document.head.appendChild(target);
    }
    for (const a of Array.from(el.attributes)) target.setAttribute(a.name, a.value);
    target.textContent = el.textContent;
  }
  document.head.querySelectorAll(`[${HEAD_ATTR}]`).forEach((el) => {
    if (!provided.has(el.getAttribute(HEAD_ATTR)!)) el.remove();
  });
}

/** Drop every rosezm-managed head element (routes without <head> blocks). */
export function clearHead(): void {
  document.head.querySelectorAll(`[${HEAD_ATTR}]`).forEach((el) => el.remove());
}

/**
 * Wire reactive markers inside `root` to the closures in `closes`.
 * Works on the live SSR DOM (adoption) and on freshly parsed fragments.
 * Returns a disposer for every effect it created.
 */
export function wire(root: Node, closes: Array<unknown>, scope?: unknown): Cleanup {
  let holder: Node = root;
  if (root.nodeType === 11) {
    const div = document.createElement('div');
    div.appendChild(root);
    holder = div;
  }

  const created: Cleanup[] = [];
  const weff = (fn: () => void) => created.push(effect(fn));

  const comments: Comment[] = [];
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) comments.push(walker.currentNode as Comment);

  const ends = new Map<number, Comment>();
  for (const c of comments) {
    const m = (c.nodeValue ?? '').match(END_RE);
    if (m) ends.set(+m[2], c);
  }

  const headBlocks: Array<{ idx: number; start: Comment; end: Comment; nodes: ChildNode[] }> = [];
  const headProvided = new Set<string>();

  for (const c of comments) {
    if (wired.has(c) || !c.parentNode) continue;
    wired.add(c);
    const m = (c.nodeValue ?? '').match(MARK_RE);
    if (!m) continue;
    const kind = m[1];
    const idx = +m[2];

    if (kind === 'h') {
      const end = ends.get(idx);
      if (!end) continue;
      const nodes: ChildNode[] = [];
      let n: ChildNode | null = c.nextSibling;
      while (n && n !== end) {
        const nx = n.nextSibling;
        nodes.push(n);
        n = nx;
      }
      headBlocks.push({ idx, start: c, end, nodes });
    } else if (kind === 'm') {
      let target = c.nextSibling;
      if (!target || target.nodeType !== 3) {
        target = document.createTextNode('');
        c.parentNode!.insertBefore(target, c.nextSibling);
      }
      const tn = target as Text;
      weff(() => {
        tn.nodeValue = String((closes[idx] as (s?: unknown) => unknown)(scope));
      });
    } else if (kind === 'i') {
      const anchor = c;
      const end = ends.get(idx);
      if (!end) continue;
      const st = anchor as unknown as { __st?: { nodes: Node[]; disp: Cleanup }; __ever?: boolean };
      weff(() => {
        if (st.__st) {
          st.__st.nodes.forEach((n) => (n as ChildNode).remove());
          st.__st.disp();
          st.__st = undefined;
        }
        const r = (closes[idx] as (s?: unknown) => unknown)(scope) as { html: string; closes: unknown[] } | null;
        if (!r) return;
        let frag: DocumentFragment;
        if (st.__ever) {
          frag = tpl(r.html);
        } else {
          st.__ever = true;
          frag = document.createDocumentFragment();
          let n = anchor.nextSibling;
          while (n && n !== end) {
            const nx = n.nextSibling;
            frag.appendChild(n);
            n = nx;
          }
        }
        const disp = wire(frag, r.closes, scope);
        const nodes = Array.from(frag.childNodes);
        const parent = anchor.parentNode!;
        for (const nd of nodes) parent.insertBefore(nd, anchor.nextSibling);
        st.__st = { nodes, disp };
      });
    } else {
      const start = c;
      const end = ends.get(idx);
      if (!end) continue;
      const st = start as unknown as { __disp?: Cleanup };
      weff(() => {
        if (st.__disp) {
          st.__disp();
          st.__disp = undefined;
        }
        const items = (closes[idx] as (s?: unknown) => unknown)(scope) as Array<{ html: string; closes: unknown[]; scope?: unknown }>;
        let n = start.nextSibling;
        while (n && n !== end) {
          const nx = n.nextSibling;
          n.remove();
          n = nx;
        }
        const parent = start.parentNode!;
        const disps: Cleanup[] = [];
        for (const r of items) {
          const frag = tpl(r.html);
          disps.push(wire(frag, r.closes, r.scope));
          for (const nd of Array.from(frag.childNodes)) parent.insertBefore(nd, end);
        }
        st.__disp = () => disps.forEach((d) => d());
      });
    }
  }

  for (let i = headBlocks.length - 1; i >= 0; i--) {
    const { idx, start, end, nodes } = headBlocks[i];
    weff(() => applyHead(String((closes[idx] as (s?: unknown) => unknown)(scope)), headProvided));
    nodes.forEach((nd) => nd.remove());
    start.remove();
    end.remove();
  }
  if (headBlocks.length === 0 && root.nodeType !== 11) clearHead();

  const els = (holder as Element).querySelectorAll('[data-b]');
  els.forEach((el) => {
    const spec = el.getAttribute('data-b')!;
    const sep = spec.indexOf(':');
    const idx = +spec.slice(0, sep);
    const attr = spec.slice(sep + 1);
    el.removeAttribute('data-b');
    weff(() => {
      el.setAttribute(attr, String((closes[idx] as (s?: unknown) => unknown)(scope)));
    });
  });

  if (holder !== root) {
    while (holder.firstChild) root.appendChild(holder.firstChild);
  }

  return () => created.forEach((fn) => fn());
}

export function resetEffects(): void {
  cleanups.forEach((fn) => fn());
  cleanups.clear();
}

let dataCache = new Map<string, Promise<unknown>>();

export function $data<T>(fn: () => T | Promise<T>): Promise<T> {
  const key = fn.toString();
  let p = dataCache.get(key);
  if (!p) {
    p = Promise.resolve(fn());
    dataCache.set(key, p);
  }
  return p as Promise<T>;
}

export function clearRequestState(): void {
  signalMap.clear();
  dataCache.clear();
}

let requestContext: Record<string, unknown> = {};

export function getContext(): Record<string, unknown> {
  return requestContext;
}

/** Fresh bag for a new request - runMiddleware() calls this before the middleware. */
export function resetRequestContext(): void {
  requestContext = {};
}

/**
 * Run an async render against a THROWAWAY signal map + data cache + mount
 * queue + cleanup set, returning the rendered result plus the signal entries,
 * the onMount callbacks and the onCleanup disposers it produced.
 *
 * Used by link prefetch: rendering the hovered route ahead of navigation must
 * not touch the live page's state (or queue its mounts / register its
 * cleanups), but the paint that consumes the entry later needs exactly those
 * things - compiled getters close over entry OBJECTS, so restoreState()
 * transplants them wholesale instead of copying values, the captured mounts
 * replay after the prefetched DOM is wired, and adoptCleanups() re-registers
 * the captured disposers so the NEXT resetEffects() disposes them (a prefetch
 * render's cleanups firing early would dispose a route that was never
 * painted, and dropping them would leak the painted route's timers).
 * Concurrent prefetches are queued by the caller (trade-off: hover prefetches
 * are rare and cheap).
 */
export async function isolateStateAsync<T>(
  fn: () => Promise<T>
): Promise<{ result: T; state: Map<string, SignalEntry>; mounts: Array<() => void>; cleanups: Set<Cleanup> }> {
  const savedSignals = signalMap;
  const savedData = dataCache;
  const savedMounts = mountQueue.splice(0, mountQueue.length);
  const savedCleanups = new Set(cleanups);
  cleanups.clear();
  signalMap = new Map();
  dataCache = new Map();
  try {
    const result = await fn();
    return {
      result,
      state: signalMap,
      mounts: mountQueue.splice(0, mountQueue.length),
      cleanups: new Set(cleanups),
    };
  } finally {
    signalMap = savedSignals;
    dataCache = savedData;
    mountQueue.splice(0, 0, ...savedMounts);
    cleanups.clear();
    savedCleanups.forEach((fn: Cleanup) => cleanups.add(fn));
  }
}

/** Adopt a prefetched route's signal entries (objects keep their subs). */
export function restoreState(entries: Map<string, SignalEntry>): void {
  signalMap.clear();
  entries.forEach((e: SignalEntry, k: string) => signalMap.set(k, e));
}

export function serializeState(): string {
  const obj: Record<string, unknown> = {};
  signalMap.forEach((v: { value: unknown }, k: string) => (obj[k] = v.value));
  return JSON.stringify(obj);
}

export function resumeState(json: string): void {
  try {
    const obj = JSON.parse(json);
    Object.entries(obj).forEach(([k, v]) => {
      entry(k, v).value = v;
    });
  } catch {
    // ignore corrupt state
  }
}

let refreshHook: (() => Promise<void>) | null = null;

export function setRefreshHook(fn: () => Promise<void>): void {
  refreshHook = fn;
}

export function refresh(): Promise<void> {
  return refreshHook ? refreshHook() : Promise.resolve();
}

const mountQueue: Array<() => void> = [];

export function onMount(fn: () => void): void {
  if (typeof document === 'undefined') return;
  mountQueue.push(fn);
}

/** Drop queued mounts - a failed render leaves stale callbacks behind. */
export function clearMounts(): void {
  mountQueue.length = 0;
}

/** Run and clear the queue; the client entry calls this after every wire(). */
export function flushMounts(): void {
  const q = mountQueue.splice(0, mountQueue.length);
  for (const fn of q) fn();
}

/** Register a disposer for the current render (the effects' cleanup channel). */
export function onCleanup(fn: Cleanup): void {
  cleanups.add(fn);
}

/**
 * Adopt a prefetched route's captured onCleanup disposers after its cached
 * paint lands: the next resetEffects() (before the following re-render) then
 * disposes them like any live route's. Without this the prefetched paint's
 * mounts would start timers nothing ever clears.
 */
export function adoptCleanups(fns: Iterable<Cleanup>): void {
  for (const fn of fns) cleanups.add(fn);
}

let LOCALES: Record<string, Record<string, string>> = {};
let DEFAULT_LOCALE = 'en';

export function setLocales(dicts: Record<string, Record<string, string>>, def: string): void {
  LOCALES = dicts;
  DEFAULT_LOCALE = def;
}

export function localeList(): string[] {
  return Object.keys(LOCALES);
}

export function isLocale(lang: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCALES, lang);
}

/**
 * Best match for an Accept-Language header among the known locales, or null
 * when it expresses no preference (absent, empty, or the `*` wildcard - which
 * Node's own fetch sends by default). A caller negotiates only on a real
 * preference; everything else serves the default locale's page in place.
 */
export function bestLocale(header: string | null | undefined): string | null {
  for (const part of (header || '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (!tag || tag === '*') continue;
    if (isLocale(tag)) return tag;
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }
  return null;
}

/**
 * Translate a key for the current language. The [lang] route param arrives
 * as state before the render (the same seeding as any dynamic param), and
 * reading it through the signal getter makes $t reactive: switching locale
 * re-runs the marker, so only the translated nodes repaint.
 */
export function $t(key: string, vars?: Record<string, string>): string {
  const [lang] = state('lang', DEFAULT_LOCALE);
  const dict = LOCALES[lang()] ?? LOCALES[DEFAULT_LOCALE] ?? {};
  let s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
  if (vars) for (const k in vars) s = s.split(`{${k}}`).join(vars[k]);
  return s;
}

const STORES = new Map<string, { value: unknown }>();
let storeTransport: ((name: string, value: unknown) => void) | null = null;

/**
 * Install the cross-process transport. The generated server entry wires the
 * cluster channel; a standalone process (dev, preview) installs none - one
 * process is one copy, which is already correct. Pass null to detach.
 */
export function setStoreTransport(fn: ((name: string, value: unknown) => void) | null): void {
  storeTransport = fn;
}

/** Apply a patch that arrived from another process (the transport's receiver
 * calls this; a store nobody opened yet is ignored - it has no reader). */
export function applyStorePatch(name: string, value: unknown): void {
  const entry = STORES.get(name);
  if (entry) entry.value = value;
}

/**
 * A named store shared by every request in this process - and, through the
 * transport, by every worker. Read it inside `$data` or a server action:
 * those are the server-only paths. A bare read in a render body is a local
 * snapshot, and on the client (where the store map is per page load and no
 * patch ever arrives) that snapshot is the initial value.
 *
 * Values must be JSON-serializable: the transport serializes them, exactly
 * like the state patch that already rides in every document.
 */
export function $store<T>(name: string, initial: T): { get(): T; set(v: T): void; update(fn: (v: T) => T): void } {
  let entry = STORES.get(name);
  if (!entry) {
    entry = { value: initial };
    STORES.set(name, entry);
  }
  const box = entry;
  return {
    get: () => box.value as T,
    set: (v: T) => {
      box.value = v;
      storeTransport?.(name, v);
    },
    update: (fn: (v: T) => T) => {
      box.value = fn(box.value as T);
      storeTransport?.(name, box.value);
    },
  };
}

/**
 * Parse the cookies of a request (server) or of this document (client, where
 * HttpOnly cookies are invisible by design - that is the point of HttpOnly).
 */
export function $cookies(request?: Request): Record<string, string> {
  const raw = request
    ? request.headers.get('cookie')
    : (typeof document !== 'undefined' ? document.cookie : '');
  const out: Record<string, string> = {};
  for (const part of (raw || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Build a Set-Cookie header VALUE for a session cookie with the safe
 * defaults: HttpOnly, SameSite=Lax, Path=/, a 7-day Max-Age. `secure` is the
 * one attribute a helper cannot infer (it depends on the deployment's TLS),
 * so pass it when serving over https - and SameSite=None forces Secure,
 * because every modern browser rejects that pairing otherwise.
 */
export function $sessionCookie(
  name: string,
  value: string,
  opts: { path?: string; maxAge?: number; sameSite?: 'Strict' | 'Lax' | 'None'; secure?: boolean; httpOnly?: boolean } = {}
): string {
  const { path = '/', maxAge = 60 * 60 * 24 * 7, sameSite = 'Lax', secure = false, httpOnly = true } = opts;
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
    httpOnly ? 'HttpOnly' : '',
    secure || sameSite === 'None' ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}
