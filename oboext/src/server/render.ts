// Server-side HTML builders for the skyscraper theme — a straight port of tools/gen.mjs's pure functions.
import type { Block } from "./schema.js";
import type { PostView, TaxRef } from "./queries.js";
import type { PageView } from "./pages.js";
import { getAvatarUrl, type AvatarSource } from "./avatar.js";
import { renderShortcodes, ensureShortcodes, type ShortcodeResolvers } from "./shortcodes.js";
import { applyAsyncFilters, HOOKS } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { inArray } from "drizzle-orm";
import { db } from "./db.js";
import { media } from "./schema.js";
import { listPosts } from "./queries.js";
import { uploadsAbsPath } from "./storage.js";
import { sanitizeHtml } from "./sanitize.js";
import fsMod from "node:fs";
import pathMod from "node:path";
import { DEFAULT_LOCALE, makeT, type Locale, type Translate } from "./i18n.js";

export function extractSubtitle(title: string): string {
  // Match pattern: "prefix 123 · subtitle · subsubtitle"
  const match = title.match(/^(.+?)\s+\d+\s*·\s*(.+)$/);
  if (!match) return "";
  return match[2].trim();
}

// F2e (responsive variants for uploads): the sibling `.wNNN` files beside an uploaded image (generated at upload time by media.ts) become a srcset.
const variantCache = new Map<string, string>();

/** Drop the memoized srcset lookup for one uploads URL (after variants land). */
export function invalidateVariantCache(url: string): void {
  variantCache.delete(url);
}

export function imgVariantAttrs(url: string): string {
  if (!url || !url.startsWith("/uploads/")) return "";
  const hit = variantCache.get(url);
  if (hit !== undefined) return hit;
  let attrs = "";
  try {
    const abs = uploadsAbsPath(url);
    const ext = abs ? pathMod.extname(abs) : "";
    if (abs && /\.(jpe?g|png)$/i.test(abs)) {
      const dir = pathMod.dirname(abs);
      const base = pathMod.basename(abs, ext);
      const dirUrl = url.slice(0, url.length - (base + ext).length);
      const widths: Array<{ w: number; u: string }> = [];
      for (const f of fsMod.readdirSync(dir)) {
        const mm = new RegExp(
          `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.w(\\d+)${ext.replace(".", "\\.")}$`,
          "i",
        ).exec(f);
        const w = mm ? Number(mm[1]) : 0;
        if (w > 0) widths.push({ w, u: `${dirUrl}${base}.w${w}${ext}` });
      }
      widths.sort((a, b) => a.w - b.w);
      if (widths.length) attrs = ` srcset="${widths.map((x) => `${esc(x.u)} ${x.w}w`).join(", ")}"`;
    }
  } catch {
    attrs = ""; // unreadable dir: no variants, no attrs
  }
  variantCache.set(url, attrs);
  return attrs;
}

// All builders here return TRUSTED html strings. Templates render them with
// the framework primitive `{@html expr}` (rosezm 0.2.4, P1-2 fix).

// --------------------------------------------------------------------- utils

export const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const pad = (n: number) => String(n).padStart(2, "0");
export function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Intl.DateTimeFormat CONSTRUCTION is the expensive half (~70µs each, measured
// on V8), and formatSiteDate runs once per rendered date: a 12-post list page
// paid ~0.86ms in constructor churn alone, against ~0.02ms with the formatters
// built once. They are immutable and keyed by timezone - an admin setting, so
// one entry in practice. A bad timezone still throws, exactly as it did when
// the constructor was called inline.
const dateFmtNumeric = new Map<string, Intl.DateTimeFormat>();
function numericDateFmt(tz: string): Intl.DateTimeFormat {
  let f = dateFmtNumeric.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFmtNumeric.set(tz, f);
  }
  return f;
}

const dateFmtShort = new Map<string, Intl.DateTimeFormat>();
function shortDateFmt(tz: string): Intl.DateTimeFormat {
  let f = dateFmtShort.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    dateFmtShort.set(tz, f);
  }
  return f;
}

export function formatSiteDate(
  v: Date | string | null | undefined,
  settings: { dateFormat?: string; timezone?: string; language?: string },
): string {
  if (!v) return "";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "";
  const tz = settings.timezone || "Asia/Shanghai";
  const parts = numericDateFmt(tz).format(d).split("-");
  const [y, m, day] = parts;
  switch (settings.dateFormat) {
    case "YYYY年M月D日":
      return `${y}年${Number(m)}月${Number(day)}日`;
    case "MMM D, YYYY":
      return shortDateFmt(tz).format(d);
    case "D/M/YYYY":
      return `${Number(day)}/${Number(m)}/${y}`;
    default:
      return `${y}-${m}-${day}`;
  }
}

// ------------------------------------------------- content pipeline (blocks)

function renderBlock(b: Block): string {
  switch (b.type) {
    case "heading": {
      const lv = Math.min(Math.max(b.level, 1), 4);
      return `<h${lv}>${esc(b.text)}</h${lv}>`;
    }
    case "paragraph":
      return `<p>${esc(b.text).replace(/\n/g, "<br/>")}</p>`;
    case "image": {
      const img = `<img src="${esc(b.url)}" alt="${esc(b.alt || "")}" loading="lazy" />`;
      const cap = b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : "";
      return `<figure class="cms-figure">${img}${cap}</figure>`;
    }
    case "quote": {
      const tipIcon =
        '<svg class="bmx-quote-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.5 1 2.5h6c0-1 .4-1.9 1-2.5A6 6 0 0 0 12 3Z"/></svg>';
      const titleHead = b.title
        ? `<div class="bmx-quote-title">${tipIcon}<span>${esc(b.title)}</span></div>`
        : "";
      return (
        `<blockquote class="bmx-quote${b.title ? " bmx-tip" : ""}">${titleHead}<p>${esc(b.text).replace(
          /\n/g,
          "<br/>",
        )}</p>${b.cite ? `<cite>— ${esc(b.cite)}</cite>` : ""}</blockquote>`
      );
    }
    case "code":
      return `<pre data-lang="${esc(b.language || "text")}"><code>${esc(b.code)}</code></pre>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}>`;
    }
    case "divider":
      return "<hr/>";
    case "html":
      return sanitizeHtml(b.html);
    default:
      return "";
  }
}
const serializeBlocks = (blocks: Block[] | null | undefined) =>
  !blocks || !blocks.length ? "" : blocks.map(renderBlock).join("\n");

/** Plain-text version (excerpts, reading-time plugin, search). */
export function blocksToPlainText(blocks: Block[] | null | undefined): string {
  return (blocks ?? [])
    .map((b) => {
      switch (b.type) {
        case "heading":
        case "paragraph":
        case "quote":
          return b.text || "";
        case "code":
          return b.code || "";
        case "list":
          return (b.items || []).join(" ");
        case "image":
          return b.caption || b.alt || "";
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** One label/value row on the post meta line (plugins append via post.meta). */
export type MetaItem = { label: string; value: string };

function addHeadingIds(html: string, slug: string): string {
  let i = 0;
  return html.replace(/<h([23])([^>]*)>/g, (_all, lv, attrs) => `<h${lv} id="${slug}-h${i++}"${attrs}>`);
}
function extractHeadings(html: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  const re = /<h([23])[^>]*>([\s\S]*?)<\/h\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ level: Number(m[1]), text: m[2].replace(/<[^>]*>/g, "").trim() });
  return out;
}

// ----------------------------------------------- syntax highlighter (port of)

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|quot|#39|amp);/g, (_m, k) =>
    k === "lt" ? "<" : k === "gt" ? ">" : k === "quot" ? '"' : k === "#39" ? "'" : "&",
  );
}
const H_NUM = /0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?/y;
const H_STR = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y;
const H_STR_DQ = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y;
const H_COMMENT = /\/\/[^\n]*|\/\*[^\n]*/y;
const hkw = (...words: string[]) => new RegExp(`\\b(?:${words.join("|")})\\b`, "y");
const H_CALL: [RegExp, string] = [/[A-Za-z_$][\w$]*(?=\s*\()/y, "f"];
const H_RULES: Record<string, [RegExp, string][]> = {
  shell: [
    [/#[^\n]*/y, "c"],
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/y, "s"],
    [/\$\{[^}]*\}|\$[A-Za-z_@#?][A-Za-z0-9_]*/y, "b"],
    [/(?<![\w-])-{1,2}[A-Za-z0-9][\w-]*/y, "b"],
    [
      hkw(
        "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
        "case", "esac", "in", "function", "return", "exit", "export", "local",
        "readonly", "unset", "source", "sudo", "set", "alias",
      ),
      "k",
    ],
    [
      hkw(
        "apt", "apt-get", "yum", "dnf", "brew", "systemctl", "service", "journalctl",
        "curl", "wget", "tar", "unzip", "gzip", "git", "docker", "docker-compose",
        "mkdir", "rmdir", "chmod", "chown", "cp", "mv", "rm", "ln", "ls", "cd",
        "pwd", "cat", "less", "tail", "head", "echo", "printf", "grep", "sed",
        "awk", "find", "xargs", "tee", "touch", "vi", "vim", "nano", "env",
        "node", "npm", "npx", "python", "python3", "pip", "pip3", "nginx",
        "postmap", "postconf", "doveadm", "firewall-cmd", "hostnamectl",
      ),
      "f",
    ],
    [H_NUM, "n"],
  ],
  script: [
    [H_COMMENT, "c"],
    [H_STR, "s"],
    [
      hkw(
        "const", "let", "var", "function", "return", "if", "else", "for", "while",
        "do", "switch", "case", "break", "continue", "new", "class", "extends",
        "super", "this", "typeof", "instanceof", "in", "of", "try", "catch",
        "finally", "throw", "async", "await", "yield", "import", "export", "from",
        "default", "static", "void", "delete", "null", "undefined", "true",
        "false", "public", "private", "protected", "readonly", "interface", "type",
        "enum", "implements", "package", "namespace", "go", "defer", "func", "chan",
        "map", "struct", "fn", "mut", "pub", "use", "match", "some", "none",
      ),
      "k",
    ],
    [H_NUM, "n"],
    H_CALL,
  ],
  python: [
    [/#[^\n]*/y, "c"],
    [H_STR_DQ, "s"],
    [/@[A-Za-z_][\w.]*/y, "b"],
    [
      hkw(
        "def", "class", "return", "if", "elif", "else", "for", "while", "try",
        "except", "finally", "with", "as", "import", "from", "lambda", "yield",
        "async", "await", "pass", "break", "continue", "raise", "in", "is",
        "not", "and", "or", "None", "True", "False", "self", "global", "nonlocal",
      ),
      "k",
    ],
    [H_NUM, "n"],
    [/[A-Za-z_][\w]*(?=\s*\()/y, "f"],
  ],
  json: [
    [/"(?:[^"\\]|\\.)*"(?=\s*:)/y, "p"],
    [/"(?:[^"\\]|\\.)*"/y, "s"],
    [/\b(?:true|false|null)\b/y, "b"],
    [H_NUM, "n"],
  ],
  yaml: [
    [/#[^\n]*/y, "c"],
    [/^[ \t-]*[A-Za-z0-9_.$-]+(?=\s*:)/ym, "p"],
    [H_STR_DQ, "s"],
    [/\b(?:true|false|yes|no|on|off|null)\b/y, "b"],
    [H_NUM, "n"],
  ],
  ini: [
    [/[#;][^\n]*/y, "c"],
    [/^\s*\[[^\]\n]*\]/ym, "k"],
    [/^[ \t]*[A-Za-z0-9_.$<>-]+(?=\s*=)/ym, "p"],
    [H_STR_DQ, "s"],
    [/\b(?:yes|no|true|false|on|off|none)\b/y, "b"],
    [H_NUM, "n"],
  ],
  sql: [
    [/--[^\n]*|\/\*[^\n]*/y, "c"],
    [H_STR_DQ, "s"],
    [
      hkw(
        "select", "from", "where", "insert", "into", "values", "update", "set",
        "delete", "create", "table", "alter", "drop", "index", "view", "join",
        "left", "right", "inner", "outer", "on", "group", "by", "order", "having",
        "limit", "offset", "as", "and", "or", "not", "null", "is", "in", "like",
        "between", "case", "when", "then", "else", "end", "primary", "key",
        "default", "references", "grant", "with", "union", "all", "distinct",
      ),
      "k",
    ],
    [H_NUM, "n"],
    [/\b[A-Za-z_]\w*(?=\s*\()/y, "f"],
  ],
  markup: [
    [/<!--[^\n]*/y, "c"],
    [/<\/?[A-Za-z][\w-]*\/?/y, "k"],
    [/[A-Za-z-_:]+(?=\s*=)/y, "p"],
    [H_STR_DQ, "s"],
    [/&[A-Za-z#0-9]+;/y, "b"],
    [/\/?>/y, "k"],
  ],
  css: [
    [/\/\*[^\n]*/y, "c"],
    [/@[\w-]+/y, "k"],
    [/[A-Za-z-]+(?=\s*:)/y, "p"],
    [/#[0-9a-fA-F]{3,8}\b/y, "b"],
    [H_STR_DQ, "s"],
    [H_NUM, "n"],
  ],
  generic: [
    [H_COMMENT, "c"],
    [/#[^\n]*/y, "c"],
    [H_STR, "s"],
    [H_NUM, "n"],
  ],
};
const H_ALIAS: Record<string, string> = {
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", fish: "shell",
  js: "script", javascript: "script", jsx: "script", mjs: "script", cjs: "script",
  ts: "script", typescript: "script", tsx: "script",
  java: "script", c: "script", h: "script", cpp: "script", cc: "script",
  csharp: "script", cs: "script", go: "script", rust: "script", rs: "script",
  php: "script", swift: "script", kotlin: "script", scala: "script", dart: "script",
  py: "python", python: "python",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml", toml: "ini",
  ini: "ini", conf: "ini", cnf: "ini", cfg: "ini", config: "ini",
  properties: "ini", env: "ini", mail: "ini", mc: "ini",
  sql: "sql", pgsql: "sql", mysql: "sql",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
  css: "css", scss: "css", less: "css",
};
function hTokenize(src: string, lang: string): string {
  const family = H_ALIAS[lang] ?? (lang ? "generic" : "");
  const rules = family ? H_RULES[family] : null;
  if (!rules) return esc(src);
  let out = "";
  let i = 0;
  while (i < src.length) {
    let hit: { text: string; kind: string } | null = null;
    for (const [re, kind] of rules) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m && m.index === i) {
        hit = { text: m[0], kind };
        break;
      }
    }
    if (hit) {
      out += `<span class="tok-${hit.kind}">${esc(hit.text)}</span>`;
      i += hit.text.length;
    } else {
      out += esc(src[i]);
      i += 1;
    }
  }
  return out;
}
const H_PRE_RE = /<pre([^>]*\bdata-lang="([^"]*)"[^>]*)><code>([\s\S]*?)<\/code><\/pre>/g;
function highlightCodeBlocks(html: string): string {
  return html.replace(H_PRE_RE, (_m, attrs, lang, code) => {
    const key = lang.trim().toLowerCase();
    if (!key || key === "text" || key === "plaintext") return `<pre${attrs}><code>${code}</code></pre>`;
    return `<pre${attrs}><code>${hTokenize(decodeEntities(code), key)}</code></pre>`;
  });
}

// Adds loading="lazy" + decoding="async" + intrinsic width/height (CLS guard) and a
// responsive srcset (when variant siblings exist) to every <img> in post/page bodies,
// including raw <img> tags from the `html` block. Hero/featured images render separately.
const contentImgDimCache = new Map<string, [number, number] | null>();

function readImageDims(abs: string): [number, number] | null {
  let fd: number;
  try {
    fd = fsMod.openSync(abs, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(32);
    let n = 0;
    while (n < buf.length) {
      const r = fsMod.readSync(fd, buf, n, buf.length - n, n);
      if (r <= 0) break;
      n += r;
    }
    if (n < 24) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      const w = buf.readUInt16LE(6);
      const h = buf.readUInt16LE(8);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    if (buf[0] === 0x42 && buf[1] === 0x4d) {
      const w = buf.readUInt32LE(18);
      const h = buf.readUInt32LE(22);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 <= n) {
        if (buf[off] !== 0xff) return null;
        const marker = buf[off + 1];
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const h = buf.readUInt16BE(off + 5);
          const w = buf.readUInt16BE(off + 7);
          return w > 0 && h > 0 ? [w, h] : null;
        }
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          off += 2;
          continue;
        }
        const len = buf.readUInt16BE(off + 2);
        if (len === 0) return null;
        off += 2 + len;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fsMod.closeSync(fd);
    } catch {
      /* noop */
    }
  }
}

export function optimizeContentImages(html: string): string {
  if (!html.includes("<img")) return html;
  return html.replace(/<img\b([^>]*)>/gi, (full, attrsRaw: string) => {
    let attrs = (attrsRaw as string).replace(/\s*\/\s*$/, "");
    const hasLoading = /\sloading\s*=/i.test(attrs);
    const hasDecoding = /\sdecoding\s*=/i.test(attrs);
    const hasDims = /\s(width|height)\s*=/i.test(attrs);
    const hasSrcset = /\ssrcset\s*=/i.test(attrs);
    if (!hasLoading) attrs = ` loading="lazy"${attrs}`;
    if (!hasDecoding) attrs = ` decoding="async"${attrs}`;
    if (!hasDims || !hasSrcset) {
      const srcM = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
      const url = srcM?.[1];
      if (url && url.startsWith("/uploads/")) {
        if (!hasSrcset) {
          const vs = imgVariantAttrs(url);
          if (vs) attrs += vs;
        }
        if (!hasDims) {
          let dim = contentImgDimCache.get(url);
          if (dim === undefined) {
            const abs = uploadsAbsPath(url);
            dim = abs ? readImageDims(abs) : null;
            contentImgDimCache.set(url, dim);
          }
          if (dim) attrs += ` width="${dim[0]}" height="${dim[1]}"`;
        }
      }
    }
    return `<img${attrs}>`;
  });
}

// Perf attributes for hero/cover/featured images (the above-the-fold LCP candidates
// that must stay eager): off-main-thread decode, optional high fetch-priority, plus
// intrinsic width/height (CLS guard) and a responsive srcset when variants exist.
export function imgPerfAttrs(
  url: string,
  opts: { lazy?: boolean; high?: boolean; srcset?: boolean } = {},
): string {
  if (!url) return "";
  let a = "";
  if (opts.lazy) a += ` loading="lazy"`;
  a += ` decoding="async"`;
  if (opts.high) a += ` fetchpriority="high"`;
  if (url.startsWith("/uploads/")) {
    if (opts.srcset !== false) {
      const vs = imgVariantAttrs(url);
      if (vs) a += vs;
    }
    let dim = contentImgDimCache.get(url);
    if (dim === undefined) {
      const abs = uploadsAbsPath(url);
      dim = abs ? readImageDims(abs) : null;
      contentImgDimCache.set(url, dim);
    }
    if (dim) a += ` width="${dim[0]}" height="${dim[1]}"`;
  }
  return a;
}

export async function buildPostBody(
  p: { content?: Block[] | null; slug: string; title?: string | null },
  kind: "post" | "page" = "post",
  highlight = false,
): Promise<string> {
  await ensurePluginsLoaded();
  ensureShortcodes();
  const blocks = (p.content ?? []) as Block[];
  let html = addHeadingIds(serializeBlocks(blocks), p.slug);
  if (highlight) html = highlightCodeBlocks(html);
  html = await renderShortcodes(html, {
    kind,
    slug: p.slug,
    siteTitle: undefined,
    resolvers: shortcodeResolvers(),
  });
  const filtered = await applyAsyncFilters<{ html: string; context: Record<string, unknown> }>(
    HOOKS.contentHtml,
    { html, context: { kind, slug: p.slug, title: p.title ?? undefined } },
  );
  return optimizeContentImages(filtered.html);
}

/** DB-backed resolvers for the [gallery]/[posts] shortcodes (original
 *  parity: lib/services/render.ts resolvers()). */
function shortcodeResolvers(): ShortcodeResolvers {
  return {
    media: async (ids) => {
      const rows = await db.select().from(media).where(inArray(media.id, ids));
      // Preserve the author's declared order.
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((i) => byId.get(i)).filter(Boolean) as typeof rows;
    },
    posts: async ({ limit, category, tag }) => {
      const { items } = await listPosts({
        status: "published",
        categorySlug: category,
        tagSlug: tag,
        limit: Math.min(Math.max(limit, 1), 50),
      });
      return items.map((p) => ({
        title: p.title,
        slug: p.slug,
        url: p.url,
        excerpt: p.excerpt,
        publishedAt: p.publishedAt,
      }));
    },
  };
}

// ------------------------------------------------------------- html builders

const CARD_COLS = "post-card-col col-xxs-6 col-xs-6 col-sm-4 col-md-4 col-lg-3 col-xl-3";

export function awardBadge(n: number): string {
  const colors: [string, string] =
    n === 1 ? ["#ffe760", "#ff9600"]
    : n === 2 ? ["#e2ecf3", "#a4b1ba"]
    : n === 3 ? ["#eadad2", "#c29f93"]
    : ["#b5b9c0", "#83868b"];
  return (
    `<svg class="award-badage" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="56" height="57" viewBox="0 0 56 57">` +
    `<defs>` +
    `<radialGradient id="f_award${n}" cx="34" cy="24" r="34" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${colors[0]}"></stop><stop offset="0.5" stop-color="${colors[1]}"></stop><stop offset="1" stop-color="${colors[1]}"></stop>` +
    `</radialGradient>` +
    `<filter id="e_award${n}" x="0" y="-1" width="57" height="61" filterUnits="userSpaceOnUse">` +
    `<feOffset result="offset" dy="10" in="SourceAlpha"></feOffset><feGaussianBlur result="blur" stdDeviation="3.6"></feGaussianBlur>` +
    `<feFlood result="flood" flood-color="${colors[1]}" flood-opacity="0.5"></feFlood><feComposite result="composite" operator="in" in2="blur"></feComposite>` +
    `<feBlend result="blend" in="SourceGraphic"></feBlend></filter>` +
    `<linearGradient id="d_award${n}" x1="27" y1="27" x2="27" y2="1" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="#fff" stop-opacity="0"></stop><stop offset="1" stop-color="#fff" stop-opacity="0.65"></stop>` +
    `</linearGradient></defs>` +
    `<path class="a_award${n}" d="M41.552,29.175L31.123,35.207a6.278,6.278,0,0,1-6.363-.076l-10.209-5.9a5.035,5.035,0,0,1-2.537-4.058V12.2a5.729,5.729,0,0,1,2.714-4.512l10.207-5.9s3.18-1.662,6.075-.041L41.081,7.57A5.979,5.979,0,0,1,44,12.189V24.5A5.2,5.2,0,0,1,41.552,29.175Z"></path>` +
    `<path class="b_award${n}" d="M14.727,7.689l6.2-3.584,0.634-.366,2.532-1.464,0.374-.216,0.471-.273s3.18-1.662,6.075-.041l0.664,0.384L32.9,2.835l0.827,0.478,3.466,2L37.8,5.67l2.714,1.57,0.572,0.33A5.864,5.864,0,0,1,42.866,9.2c-13.7,1.668-25.377,12.58-30.32,17.894a4.849,4.849,0,0,1-.534-1.928V12.2A5.729,5.729,0,0,1,14.727,7.689Z"></path>` +
    `<text class="c_award${n}" x="28" y="24">${n}</text></svg>`
  );
}

export function postCard(p: PostView, award = 0, t?: Translate): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  const img = p.featuredImage
    ? `<a class="post-thumbnail-wrapper" href="${esc(p.url)}"><img src="${esc(p.featuredImage)}"${imgVariantAttrs(p.featuredImage)}${imgPerfAttrs(p.featuredImage, { srcset: false })} crossorigin="anonymous"></a>`
    : `<a class="post-thumbnail-wrapper" href="${esc(p.url)}"></a>`;
  const subtitle = extractSubtitle(p.title);
  return (
    `<div class="${CARD_COLS}"><div class="post-card">` +
    (award ? awardBadge(award) : "") +
    `<div class="title"><span>${esc(p.title)}</span>${subtitle ? `<span class="subtitle">${esc(subtitle)}</span>` : ""}</div>` +
    img +
    `<div class="metas"><time class="time">${fmtDate(p.publishedAt)}</time>` +
    `<div class="info">` +
    `<span class="reads" data-toggle="tooltip" title="${L("post.reads_tip")}"><i class="skyscraper-icons-book-reader"></i>${p.views ?? 0}</span>` +
    `<span class="likes" data-toggle="tooltip" title="${L("post.likes_tip")}"><i class="skyscraper-icons-heart"></i>${p.likes ?? 0}</span>` +
    `<span class="comments" data-toggle="tooltip" title="${L("comments.title")}"><i class="skyscraper-icons-comment"></i>${p.commentsCount ?? 0}</span>` +
    `</div><a class="read-more" href="${esc(p.url)}">${L("post.read_more")}</a></div></div></div>`
  );
}

export function nestedCard(p: PostView, t?: Translate): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  const img = p.featuredImage
    ? `<img src="${esc(p.featuredImage)}"${imgVariantAttrs(p.featuredImage)}${imgPerfAttrs(p.featuredImage, { srcset: false })} crossorigin="anonymous">`
    : "";
  const subtitle = extractSubtitle(p.title);
  return (
    `<div class="post-card-nested-col"><div class="post-card is-nested">` +
    `<div class="title"><span>${esc(p.title)}</span>${subtitle ? `<span class="subtitle">${esc(subtitle)}</span>` : ""}</div>` +
    `<a class="post-thumbnail-wrapper" href="${esc(p.url)}">${img}</a>` +
    `<div class="metas"><time class="time">${fmtDate(p.publishedAt)}</time>` +
    `<div class="info">` +
    `<span class="reads" data-toggle="tooltip" title="${L("post.reads_tip")}"><i class="skyscraper-icons-book-reader"></i>${p.views ?? 0}</span>` +
    `<span class="likes" data-toggle="tooltip" title="${L("post.likes_tip")}"><i class="skyscraper-icons-heart"></i>${p.likes ?? 0}</span>` +
    `<span class="comments" data-toggle="tooltip" title="${L("comments.title")}"><i class="skyscraper-icons-comment"></i>${p.commentsCount ?? 0}</span>` +
    `</div><a class="read-more" href="${esc(p.url)}">${L("post.read_more")}</a></div></div></div>`
  );
}

export const section = (title: string, inner: string): string =>
  `<div class="clearfix"><div class="pf-modal-title"><span class="title-text">${title}</span></div>${inner}</div>`;

export const cardRow = (items: PostView[], awards = false, t?: Translate): string =>
  items.length === 0
    ? `<div class="sk-empty">${(t ?? makeT(DEFAULT_LOCALE))("empty.posts")}</div>`
    : `<div class="row post-card-row">${items.map((p, i) => postCard(p, awards ? i + 1 : 0, t)).join("")}</div>`;

// --------------------------------------------------------------- post pages

const ICON_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>';
const ICON_WEIBO =
  '<svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M407 177.6c7.6-24-13.4-46.8-37.4-41.7c-22 4.8-28.8-28.1-7.1-32.8c50.1-10.9 92.3 37.1 76.5 84.8c-6.8 21.2-38.8 10.8-32-10.3M214.8 446.7C108.5 446.7 0 395.3 0 310.4c0-44.3 28-95.4 76.3-143.7C176 67 279.5 65.8 249.9 161c-4 13.1 12.3 5.7 12.3 6c79.5-33.6 140.5-16.8 114 51.4c-3.7 9.4 1.1 10.9 8.3 13.1c135.7 42.3 34.8 215.2-169.7 215.2m143.7-146.3c-5.4-55.7-78.5-94-163.4-85.7c-84.8 8.6-148.8 60.3-143.4 116s78.5 94 163.4 85.7c84.8-8.6 148.8-60.3 143.4-116M347.9 35.1c-25.9 5.6-16.8 43.7 8.3 38.3c72.3-15.2 134.8 52.8 111.7 124c-7.4 24.2 29.1 37 37.4 12c31.9-99.8-55.1-195.9-157.4-174.3m-78.5 311c-17.1 38.8-66.8 60-109.1 46.3c-40.8-13.1-58-53.4-40.3-89.7c17.7-35.4 63.1-55.4 103.4-45.1c42 10.8 63.1 50.2 46 88.5m-86.3-30c-12.9-5.4-30 .3-38 12.9c-8.3 12.9-4.3 28 8.6 34c13.1 6 30.8.3 39.1-12.9c8-13.1 3.7-28.3-9.7-34m32.6-13.4c-5.1-1.7-11.4.6-14.3 5.4c-2.9 5.1-1.4 10.6 3.7 12.9c5.1 2 11.7-.3 14.6-5.4c2.8-5.2 1.1-10.9-4-12.9"></path></svg>';
const ICON_QQ =
  '<svg width="17" height="17" viewBox="0 0 448 512" fill="currentColor" aria-hidden="true"><path d="M433.754 420.445c-11.526 1.393-44.86-52.741-44.86-52.741c0 31.345-16.136 72.247-51.051 101.786c16.842 5.192 54.843 19.167 45.803 34.421c-7.316 12.343-125.51 7.881-159.632 4.037c-34.122 3.844-152.316 8.306-159.632-4.037c-9.045-15.25 28.918-29.214 45.783-34.415c-34.92-29.539-51.059-70.445-51.059-101.792c0 0-33.334 54.134-44.859 52.741c-5.37-.65-12.424-29.644 9.347-99.704c10.261-33.024 21.995-60.478 40.144-105.779C60.683 98.063 108.982.006 224 0c113.737.006 163.156 96.133 160.264 214.963c18.118 45.223 29.912 72.85 40.144 105.778c21.768 70.06 14.716 99.053 9.346 99.704"></path></svg>';
const ICON_QZONE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-star"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"></path></svg><span class="z absolute">z</span>';
const ICON_HEART =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-heart"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>';

export function shareBar(p: PostView, siteName = "", siteDescription = ""): string {
  const likes = p.likes ?? 0;
  return (
    `<div class="share-modal" data-post-id="${p.id}" data-likes="${likes}"` +
    ` data-title="${esc(p.title)}" data-excerpt="${esc(p.excerpt || "")}" data-thumb="${esc(p.featuredImage || "")}"` +
    ` data-site="${esc(siteName)}" data-desc="${esc(siteDescription)}">` +
    `<button type="button" class="image">${ICON_IMAGE}</button>` +
    `<button type="button" class="likes">${ICON_WEIBO}</button>` +
    `<button type="button" class="qq">${ICON_QQ}</button>` +
    `<button type="button" class="qzone">${ICON_QZONE}</button>` +
    `<button type="button" class="likes -o">${ICON_HEART}</button> ${likes}</div>`
  );
}

function isoDuration(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const hh = h > 0 ? h + "H" : "";
  return "PT" + hh + r + "M";
}

// MRSS <media:content> for an RSS item's featured image; resolves a relative
// /uploads/... URL against the origin so the feed stays self-contained.
export function mediaImageTag(url: string | null | undefined, origin: string): string {
  if (!url) return "";
  const abs = url.startsWith("http") ? url : `${origin}${url}`;
  return `<media:content url="${esc(abs)}" medium="image" />`;
}

// og:image + og:image:width/height/alt + twitter:image for one social card.
// An ABSOLUTE URL is mandatory in the OG spec - scrapers silently drop a
// relative path - and intrinsic dimensions let Facebook render the card
// without a second fetch. Dims come from the same memoized uploads reader the
// content images use; alt text is the caller's title. No image -> "".
export function socialImageMetas(
  url: string | null | undefined,
  origin: string,
  alt: string,
): string {
  if (!url) return "";
  const abs = url.startsWith("http") ? url : `${origin}${url}`;
  const parts = [`<meta property="og:image" content="${esc(abs)}">`];
  if (url.startsWith("/uploads/")) {
    let dim = contentImgDimCache.get(url);
    if (dim === undefined) {
      const absPath = uploadsAbsPath(url);
      dim = absPath ? readImageDims(absPath) : null;
      contentImgDimCache.set(url, dim);
    }
    if (dim) {
      parts.push(`<meta property="og:image:width" content="${dim[0]}">`);
      parts.push(`<meta property="og:image:height" content="${dim[1]}">`);
    }
  }
  if (alt) parts.push(`<meta property="og:image:alt" content="${esc(alt)}">`);
  parts.push(`<meta name="twitter:image" content="${esc(abs)}">`);
  return parts.join("");
}

export function postHead(
  p: PostView,
  siteTitle: string,
  siteDescription: string,
  origin: string,
  /** Social-card fallback when the post has no cover: the site logo. */
  logoUrl?: string,
  /** Reading stats for BlogPosting JSON-LD (wordCount / timeRequired). */
  read?: { wordCount: number; minutes: number },
): string {
  const fullTitle = `${p.seoTitle || p.title} - ${siteTitle}`;
  const desc = p.seoDescription || p.excerpt || siteDescription;
  const url = `${origin}${p.url}`;
  const ogImage = p.featuredImage || logoUrl || "";
  const primaryCat = p.categories?.[0]?.name ?? "";
  const tagMetas = (p.tags ?? []).map((t) => `<meta property="article:tag" content="${esc(t.name)}">`).join("");
  const author = p.author?.name;
  const iso = (v: Date | string | null | undefined) => new Date(v ?? p.publishedAt!).toISOString();
  // BreadcrumbList: home -> (primary category) -> this post. The first crumb
  // doubles as the site root entry; a post without categories is Home->Post.
  const crumbs: Array<{ name: string; url: string }> = [
    { name: siteTitle, url: `${origin}/` },
  ];
  if (p.categories?.[0]) crumbs.push({ name: p.categories[0].name, url: `${origin}${p.categories[0].url}` });
  crumbs.push({ name: p.title, url });
  const posting: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: p.title,
    description: desc,
    datePublished: iso(p.publishedAt),
    dateModified: iso(p.updatedAt || p.publishedAt),
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    author: author ? { "@type": "Person", name: author } : undefined,
    publisher: { "@type": "Organization", name: siteTitle },
  };
  if (p.featuredImage) posting.image = [p.featuredImage];
  if (p.tags?.length) posting.keywords = p.tags.map((t) => t.name).join(", ");
  if (read) {
    if (read.wordCount > 0) posting.wordCount = read.wordCount;
    posting.timeRequired = isoDuration(read.minutes);
  }
  return [
    `<title>${esc(fullTitle)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<meta name="robots" content="index, follow">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:title" content="${esc(fullTitle)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    socialImageMetas(ogImage, origin, p.title),
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${esc(siteTitle)}">`,
    primaryCat ? `<meta property="article:section" content="${esc(primaryCat)}">` : "",
    tagMetas,
    `<meta property="article:published_time" content="${iso(p.publishedAt)}">`,
    `<meta property="article:modified_time" content="${iso(p.updatedAt || p.publishedAt)}">`,
    author ? `<meta property="article:author" content="${esc(author)}">` : "",
    `<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${esc(fullTitle)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    jsonLd(posting),
    jsonLd({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.name,
        item: c.url,
      })),
    }),
  ].filter(Boolean).join("");
}

// --------------------------------------------------------------- comments

export type FlatComment = {
  id: number;
  parentId: number | null;
  authorName: string;
  authorEmail: string | null;
  authorUrl: string | null;
  content: string;
  createdAt: Date | string;
};

export type CommentModel = {
  postId: number;
  postType: string;
  open: boolean;
  enabled: boolean;
  provider: string;
  requireNameEmail: boolean;
  /** Guest comments must carry a link. Independent of requireNameEmail. */
  requireAuthorUrl: boolean;
  authorUrlLabel: string;
  defaultContent: string;
  me: { id: number; name: string; email: string } | null;
  items: FlatComment[];
  avatar: { source: AvatarSource; size: number; default: string; rating: string };
  config: Record<string, unknown>;
  locale: Locale;
  t?: Translate;
};

const DFLT_AVATAR_BG = "linear-gradient(135deg,#dce8f7,#bcd6f3)";

function safeCommentUrl(u?: string | null): string | null {
  if (!u) return null;
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

function fmtCommentDate(v: Date | string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ICON_REPLY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
const ICON_SMILE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg>';
const ICON_USER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const ICON_MAIL =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
const ICON_LINK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const ICON_RESET =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const ICON_SEND =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';

type CommentNode = FlatComment & { children: CommentNode[] };

function commentT(m: CommentModel): Translate {
  return m.t ?? makeT(m.locale || DEFAULT_LOCALE);
}

function buildCommentTree(flat: FlatComment[]): CommentNode[] {
  const byId = new Map<number, CommentNode>();
  flat.forEach((c) => byId.set(c.id, { ...c, children: [] }));
  const roots: CommentNode[] = [];
  flat.forEach((c) => {
    const node = byId.get(c.id)!;
    if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId)!.children.push(node);
    else roots.push(node);
  });
  return roots;
}

function renderCommentNodes(
  nodes: CommentNode[],
  m: CommentModel,
  depth: number,
  parentName?: string,
): string {
  const inner = nodes
    .map((n) => {
      const L = commentT(m);
      const url = safeCommentUrl(n.authorUrl);
      const name = url
        ? `<div class="name has-url"><a href="${esc(url)}" target="_blank" rel="nofollow noopener noreferrer">${esc(n.authorName)}</a></div>`
        : `<div class="name"><span>${esc(n.authorName)}</span></div>`;
      const avatar = getAvatarUrl(n.authorEmail, m.avatar);
      const bg = avatar ? `background-image:url(&quot;${esc(avatar)}&quot;)` : "";
      const reply = m.open
        ? `<span><div class="flex-shrink-0 reply flex items-center" data-comment-reply=${n.id} title="${esc(L("comments.reply"))}">${ICON_REPLY}</div></span>`
        : "";
      const parentInfo = parentName
        ? `<span class="parent-info">${esc(L("comments.reply_to", { name: esc(parentName) }))}</span>`
        : "";
      const children = n.children.length
        ? renderCommentNodes(n.children, m, depth + 1, n.authorName)
        : "";
      return (
        `<li id="comment-item-${n.id}"><div class="wrapper flex">` +
        `<div class="avatar relative flex-shrink-0" style="${bg || DFLT_AVATAR_BG}"><div class="highlight"></div></div>` +
        `<div class="body flex-grow"><div class="flex items-start">` +
        `<div class="flex-grow flex items-center justify-between info">${name}<div class="date">${fmtCommentDate(n.createdAt)}</div></div>` +
        `${reply}</div>` +
        `<div class="content has-emoji">${parentInfo}${esc(n.content)}</div>` +
        `</div></div>${children}</li>`
      );
    })
    .join("");
  return `<ul class="comment-list${depth === 0 ? "" : " sub-list"}">${inner}</ul>`;
}

function builtinCommentsHtml(m: CommentModel): string {
  const L = commentT(m);
  if (!m.open) return '<div class="sf-comment-close">' + esc(L("comments.closed_post")) + "</div>";

  const meBox = m.me
    ? '<div class="sf-comment-me">' +
      `<span class="sf-comment-me-avatar">${esc((m.me.name || "?").charAt(0).toUpperCase())}</span>` +
      '<span class="sf-comment-me-meta">' +
      `<span class="sf-comment-me-name">${esc(m.me.name)}</span>` +
      `<span class="sf-comment-me-email">${esc(m.me.email)}</span>` +
      "</span></div>"
    : "";
  const guestFields = m.me
    ? ""
    : '<div class="guest-info flex">' +
      '<div class="item"><input type="text" class="comment-field" name="authorName" autocomplete="nickname" placeholder=' +
      `"${esc(L("comments.nickname"))}${m.requireNameEmail ? " *" : ""}">` +
      `<i>${ICON_USER}</i></div>` +
      '<div class="item"><input type="email" class="comment-field" name="authorEmail" autocomplete="email" placeholder=' +
      `"${esc(L("comments.email"))}${m.requireNameEmail ? " *" : ""}">` +
      `<i>${ICON_MAIL}</i></div>` +
      `<div class="item"><input type="url" class="comment-field" name="authorUrl" autocomplete="url" placeholder="${esc(m.authorUrlLabel)}${m.requireAuthorUrl ? " *" : ""}"><i>${ICON_LINK}</i></div>` +
      "</div>";

  // The toolbar is ONE row: the emoji trigger on the left, the submit on the
  // right, space between. They used to be two sibling blocks - .funcs holding
  // the emoji button and .form-actions holding the submit - so the emoji button
  // sat on a line of its own, full width, with the submit stranded on the line
  // below. Nothing in the CSS could fix that: two block-level children of the
  // same parent do not share a line, whatever their display values say.
  //
  // The panel span stays INSIDE the left group, because the panel is positioned
  // against it (positionEmoji measures the host to decide above/below), so the
  // host must remain the element the button is in.
  const form =
    '<form class="comment-form sf-comment-form my-5" novalidate data-comment-form ' +
    `data-post-id=${m.postId} data-post-type=${esc(m.postType)} data-require=${m.requireNameEmail ? "1" : "0"}` +
    ` data-require-url=${m.requireAuthorUrl ? "1" : "0"} data-comment-locale=${esc(m.locale || DEFAULT_LOCALE)}>` +
    '<input type="hidden" name="parentId" value="">' +
    meBox +
    guestFields +
    '<div class="input">' +
    `<textarea name="content" placeholder="${esc(L("comments.placeholder"))}">${esc(m.defaultContent || "")}</textarea></div>` +
    '<div class="sf-toolbar">' +
    // No mx-5 here: the toolbar's own padding already insets the row, so the
    // margin pushed the emoji trigger 20px further right than the textarea
    // edge above it - the button did not line up with the field it belongs to.
    // The panel is positioned against .funcs, so it stays inside this element.
    '<div class="funcs">' +
    `<button type="button" aria-label="${esc(L("comments.emoji"))}" title="${esc(L("comments.emoji"))}" data-comment-emoji>${ICON_SMILE}</button>` +
    '<span class="emoji-panel-wrap" data-emoji-panel aria-hidden="true"></span>' +
    "</div>" +
    '<div class="form-actions">' +
    `<button type="button" class="cancel" data-comment-cancel style="display:none">${ICON_RESET}${esc(L("comments.cancel_reply"))}</button>` +
    `<button type="submit" class="btn-submit">${ICON_SEND}<span data-submit-label>${esc(L("comments.submit"))}</span></button>` +
    "</div></div></form>";

  const tree = m.items.length
    ? renderCommentNodes(buildCommentTree(m.items), m, 0)
    : '<div class="sf-comment-close">' + esc(L("comments.empty")) + "</div>";
  return '<div data-comment-notice class="sf-comment-close" style="display:none;color:var(--primary-color)"></div>' + form + tree;
}

function commentsInner(m: CommentModel): string {
  const L = commentT(m);
  if (!m.enabled || m.provider === "none") {
    return '<div class="sf-comment-close">' + esc(L("comments.closed")) + "</div>";
  }
  if (m.provider !== "builtin") {
    return '<div class="sf-comment-provider" data-comment-provider="' + esc(m.provider) +
      '" data-config="' + esc(JSON.stringify(m.config)) + '" data-comment-locale=' + esc(m.locale || DEFAULT_LOCALE) + '></div>';
  }
  return builtinCommentsHtml(m);
}

export function commentsSection(m: CommentModel): string {
  const L = commentT(m);
  return '<section class="sk-section sk-comments"><h2 class="title_style_01">' + esc(L("comments.title")) + "</h2>" +
    commentsInner(m) + "</section>";
}

export function commentsBare(m: CommentModel): string {
  return commentsInner(m);
}

/** Cover + first inline images — the flickering collage backdrop of the
 *  gallery header. Empty array = plain article header.
 *  mirror themes/skyscraper/PostPage.tsx collectGalleryImages。 */
function collectGalleryImages(html: string, featured?: string | null): string[] {
  const out: string[] = [];
  if (featured) out.push(featured);
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 9) {
    if (out.indexOf(m[1]) === -1) out.push(m[1]);
  }
  return out;
}

export function postPage(
  p: PostView,
  related: PostView[],
  commentsHtml = "",
  pluginMeta: MetaItem[] = [],
  bodyHtml: string,
  blogIndex = "/blog",
  t?: Translate,
): string {
  const L = (k: string, v?: Record<string, string | number>) => (t ? t(k, v) : makeT(DEFAULT_LOCALE)(k, v));
  const cat = p.categories[0] ?? null;
  const meta =
    '<div class="meta">' +
    (cat ? `<span>${esc(cat.name)}</span>` : "") +
    `<span> · ${fmtDate(p.publishedAt)}</span>` +
    `<span> · ${L("post.reads", { n: p.views ?? 0 })}</span>` +
    `<span> · ${L("post.comments", { n: p.commentsCount ?? 0 })}</span>` +
    pluginMeta.map((m) => `<span> · ${esc(m.label)}：${esc(m.value)}</span>`).join("") +
    "</div>";
  const renderedBody = bodyHtml;
  const headings = extractHeadings(renderedBody);
  const toc = headings.length
    ? `<div class="sk-toc"><div class="toc-title">${L("post.toc")}</div><ul>` +
      headings
        .map(
          (h, i) =>
            `<li${h.level === 3 ? ' class="toc-h3"' : ""}><a href="#${p.slug}-h${i}">${esc(h.text)}</a></li>`,
        )
        .join("") +
      "</ul></div>"
    : "";
  const tags = p.tags.length
    ? '<div class="tags">' + p.tags.map((t) => `<a href="${esc(t.url)}"># ${esc(t.name)}</a>`).join("") + "</div>"
    : "";
  // Gallery header is a post *format*, not a side effect of having a featured
  // image: every standard post has one, but only format=gallery gets the
  // 450px flickering banner (and the article card's negative-margin overlap).
  
  const isGallery = (p as { format?: string }).format === "gallery";
  const galleryImgs = isGallery ? collectGalleryImages(renderedBody, p.featuredImage) : [];
  const showBanner = isGallery && galleryImgs.length > 0;
  const banner = showBanner
    ? '<div class="gallery_slider">' +
      '<div class="background" aria-hidden="true">' +
      galleryImgs.map((src) => `<img src="${esc(src)}" alt="">`).join("") +
      "</div>" +
      `<h1>${esc(p.title)}</h1>` +
      '<div class="info">' +
      (cat ? `<span>${esc(cat.name)}</span>` : "") +
      `<span>${fmtDate(p.publishedAt)}</span>` +
      `<span>${L("post.reads", { n: p.views ?? 0 })}</span>` +
      "</div>" +
      `<a class="play" href="#post-body"><i class="sk-i-play"></i>${L("post.gallery")}</a>` +
      "</div>"
    : "";
  return (
    `<div class="sk-postpage${showBanner ? " is-gallery" : ""}">` +
    `<div class="sk-crumbs"><a href="/">${L("crumb.home")}</a> / <a href="${esc(blogIndex)}">${L("list.all")}</a> / <span>${esc(p.title)}</span></div>` +
    banner +
    '<article class="post-wrapper" id="post-body">' +
    (showBanner ? "" : meta) +
    (showBanner ? "" : `<h1>${esc(p.title)}</h1>`) +
    (showBanner || !p.excerpt ? "" : `<p class="sk-muted">${esc(p.excerpt)}</p>`) +
    toc +
    `<div class="post-content prose-cms">${renderedBody}</div>` +
    tags +
    shareBar(p) +
    `<div class="post-nav"><a href="${esc(blogIndex)}">← ${L("post.back_list")}</a></div>` +
    "</article>" +
    `<section class="sk-section"><h2 class="title_style_01">${L("post.related")}</h2>` +
    cardRow(related, false, t) +
    "</section>" +

    `<section class="sk-section sk-comments"><h2 class="title_style_01">${L("comments.title")}</h2>` +
      (commentsHtml || `<div class="sf-comment-close">${L("comments.closed")}</div>`) +
    "</section>" +
    "</div>"
  );
}

// ---------------------------------------------------------------- page pages

/** Skyscraper PageBySlug uses slash dates in its meta line. */
function fmtDateSlash(v: Date | string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/**
 * One `application/ld+json` script tag carrying `obj` as compact JSON.
 * `<` is escaped to `\u003c` so a value containing `</script>` (a title, an
 * excerpt) can never close the tag early — JSON is valid with the escape and
 * every JSON-LD consumer decodes it back.
 */
export function jsonLd(obj: unknown): string {
  const json = JSON.stringify(obj).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

export function pageHead(
  p: PageView,
  siteTitle: string,
  siteDescription: string,
  origin: string,
  /** Social-card fallback when the page has no cover: the site logo. */
  logoUrl?: string,
  /** Reading stats for the WebPage JSON-LD (wordCount / timeRequired). */
  read?: { wordCount: number; minutes: number },
): string {
  const fullTitle = `${p.seoTitle || p.title} - ${siteTitle}`;
  const desc = p.seoDescription || p.excerpt || siteDescription;
  const url = `${origin}${p.url}`;
  const ogImage = p.featuredImage || logoUrl || "";
  return [
    `<title>${esc(fullTitle)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<meta name="robots" content="index, follow">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:title" content="${esc(fullTitle)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    socialImageMetas(ogImage, origin, p.title),
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(siteTitle)}">`,

    `<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${esc(fullTitle)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    jsonLd((() => {
      const wp: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: fullTitle,
        description: desc,
        url,
      };
      if (read) {
        if (read.wordCount > 0) wp.wordCount = read.wordCount;
        wp.timeRequired = isoDuration(read.minutes);
      }
      return wp;
    })()),
    jsonLd({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: siteTitle, item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: p.title, url },
      ],
    }),
  ]
    .filter(Boolean)
    .join("");
}

export function pagePage(
  p: PageView,
  recent: PostView[],
  commentsHtml = "",
  bodyHtml: string,
  t?: Translate,
): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  const renderedBody = bodyHtml;
  const lis = recent
    .map(
      (x) =>
        `<li style="padding:8px 0;border-bottom:1px dashed var(--sk-border-strong)">` +
        `<a href="${esc(x.url)}">${esc(x.title)}</a>` +
        `<span class="sk-muted" style="float:right;font-size:12px">${fmtDateSlash(
          x.publishedAt,
        )}</span></li>`,
    )
    .join("");
  const recentSection = recent.length
    ? `<section class="sk-section"><h2 class="title_style_01">${L("sidebar.recent")}</h2>` +
      `<ul style="list-style:none;margin:0;padding:0">${lis}</ul></section>`
    : "";
  return (
    '<div class="sk-postpage">' +
    `<div class="sk-crumbs"><a href="/">${L("crumb.home")}</a> / <span>${esc(p.title)}</span></div>` +
    '<article class="post-wrapper">' +
    `<span class="share-ribbon" aria-hidden="true"><span class="content">` +
    `<i class="sk-i-share"></i>${L("post.share")}</span></span>` +
    `<div class="meta"><span>${fmtDateSlash(p.publishedAt)}</span></div>` +
    `<h1>${esc(p.title)}</h1>` +
    `<div class="post-content prose-cms">${renderedBody}</div>` +
    "</article>" +
    recentSection +

    `<section class="sk-section sk-comments"><h2 class="title_style_01">${L("comments.title")}</h2>` +
      (commentsHtml || `<div class="sf-comment-close">${L("comments.closed")}</div>`) +
    "</section>" +
    "</div>"
  );
}

// ---------------------------------------------------------------- home page

const POS0 = ["current", "future0", "future1", "future2"];
function heroPage(p: PostView, pos: number): string {
  const c = p.categories[0] ?? null;
  return (
    `<div class="page ${POS0[pos]}" data-url="${esc(p.url)}" data-cat="${esc(c?.name ?? "")}"` +
    ` data-date="${fmtDate(p.publishedAt)}" data-reads="${p.views ?? 0}" data-comments="${p.commentsCount ?? 0}"><div class="title">` +
    (c ? `<div class="type">${esc(c.name)}</div>` : "") +
    `<div class="post">${esc(p.title)}</div></div>` +
    `<a class="img" tabindex="-1" style="background-image:url(${esc(p.featuredImage ?? "")})" href="${esc(p.url)}"></a></div>`
  );
}
function heroMeta(p: PostView, t?: Translate): string {
  const L = (k: string, v?: Record<string, string | number>) =>
    t ? t(k, v) : makeT(DEFAULT_LOCALE)(k, v);
  const c = p.categories[0] ?? null;
  return (
    `<div class="meta-wrapper"><div class="meta">` +
    (c ? `<div class="taxonomy">${esc(c.name)}</div>` : "") +
    `<a class="title" href="${esc(p.url)}">${esc(p.title)}</a>` +
    `<div class="meta-bottom"><time>${fmtDate(p.publishedAt)}</time>` +
    `<span class="reads">${L("theme.reads", { n: p.views ?? 0 })}</span>` +
    `<span class="comments">${L("theme.comments", { n: p.commentsCount ?? 0 })}</span></div>` +
    `<a class="goto" href="${esc(p.url)}">${L("post.read_more")}</a></div></div>`
  );
}

export function cardFlip(hero: PostView[], t?: Translate): string {
  if (!hero.length) return "";
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  return (
    `<section class="cardFlip" id="cardFlip">` +
    `<div class="background" aria-hidden="true"><div class="default-background"><div class="head-img"><div class="img"></div></div></div></div>` +
    `<div class="slider-wrapper" aria-hidden="true"><div class="cardFlip-slider">` +
    hero.map((p, i) => heroPage(p, i)).join("") +
    `</div></div>` +
    heroMeta(hero[0], t) +
    `<div class="navigator"><div class="prev" role="button" tabindex="0" aria-label="${L("adjacent.older")}"><i class="skyscraper-icons-arrow-left"></i></div>` +
    `<div class="next" role="button" tabindex="0" aria-label="${L("adjacent.newer")}"><i class="skyscraper-icons-arrow-left sk-i-flip-x"></i></div></div>` +
    `</section>`
  );
}

export function scrollCats(cats: TaxRef[]): string {
  return (
    `<div class="scroll-cats">` +
    cats
      .slice(0, 3)
      .map((c) => `<a class="scroll-cat" href="${esc(c.url)}"><span class="name">${esc(c.name)}</span></a>`)
      .join("") +
    `</div>`
  );
}

export function homeHtml(parts: {
  hero: PostView[];
  latest: PostView[];
  liked: PostView[];
  random: PostView[];
  cats: TaxRef[];
  t?: Translate;
}): string {
  const L = (k: string) => (parts.t ? parts.t(k) : makeT(DEFAULT_LOCALE)(k));
  // Trade-off: skyscraper theme-settings showCatsStrip assumed on; read the
  // themes table if an admin switch appears in B/C phase.
  return (
    '<div class="sk-home">' +
    cardFlip(parts.hero, parts.t) +
    (parts.cats.length ? scrollCats(parts.cats) : "") +
    section(L("sidebar.recent"), cardRow(parts.latest, false, parts.t)) +
    (parts.liked.length ? section(L("rank.most_likes"), cardRow(parts.liked, true, parts.t)) : "") +
    (parts.random.length
      ? section(L("rank.random"), `<div class="row post-card-nested-row">${parts.random.map((c) => nestedCard(c, parts.t)).join("")}</div>`)
      : "") +
    "</div>"
  );
}

// --------------------------------------------------------------- list pages

export function pager(page: number, totalPages: number, hrefFor: (p: number) => string, t?: Translate): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  if (totalPages <= 1) return "";
  let html = '<nav class="sk-pager">';
  if (page > 1) html += `<a href="${esc(hrefFor(page - 1))}">‹ ${L("pager.prev")}</a>`;
  for (let p = 1; p <= totalPages; p++) {
    html += p === page ? `<em>${p}</em>` : `<a href="${esc(hrefFor(p))}">${p}</a>`;
  }
  if (page < totalPages) html += `<a href="${esc(hrefFor(page + 1))}">${L("pager.next")} ›</a>`;
  return html + "</nav>";
}

export function listPage(parts: {
  title: string;
  sub: string;
  items: PostView[];
  page: number;
  totalPages: number;
  hrefFor: (p: number) => string;
  showPager?: boolean;
  extra?: string;
  t?: Translate;
}): string {
  const showPager = parts.showPager ?? true;
  return (
    '<section class="sk-section sk-list-page">' +
    `<h1 class="title_style_01">${parts.title}</h1>` +
    `<div class="sk-list-sub sk-muted">${parts.sub}</div>` +
    '<div class="clearfix">' +
    cardRow(parts.items, false, parts.t) +
    "</div>" +
    (showPager ? pager(parts.page, parts.totalPages, parts.hrefFor, parts.t) : "") +
    (parts.extra ?? "") +
    "</section>"
  );
}

// ------------------------------------------------------------------- chrome

export function topNav(settings: Record<string, any>): string {
  const title = esc(settings.siteTitle ?? "");
  // The loaders' settings bag carries the bound translator (settings.t) under
  // a non-default locale; the Chinese default catalog is the fallback.
  const bound: Translate | undefined =
    typeof settings.t === "function" ? settings.t : undefined;
  const L = (k: string) => (bound ? bound(k) : makeT(DEFAULT_LOCALE)(k));

  const isHome = String(settings.__pathname ?? "/") === "/";
  const navCls = `top-nav is-sticky${isHome ? "" : " is-scrolled always-stay"}`;
  return (
    `<header class="${navCls}">` +
    `<div class="sidebar-btn" role="button" tabindex="0" aria-label="${L("sky.sidebar_open")}"><i class="skyscraper-icons-bread"></i><i class="skyscraper-icons-cross closeBtn"></i></div>` +
    `<div class="toolbox-btn" role="button" tabindex="0" aria-label="${L("sky.toolbox_open")}"><i class="skyscraper-icons-cog"></i></div>` +
    `<div class="container"><div class="logo"><center><a aria-label="${title}" href="/"><div class="sk-logo">${title}</div></a></center></div>` +
    `<div class="toolbox"><div class="return-btn"><i class="skyscraper-icons-arrow-left"></i></div>` +
    `<div class="search sk-live-search"><i class="skyscraper-icons-search"></i>` +
    `<form role="search" action="/search" method="get"><input id="pf_header_search" type="search" placeholder="${L("search.placeholder")}" autocomplete="off" name="q" value=""></form></div>` +
    `<div class="color-switcher-wrapper"><div class="mobile-button show-on-desktop" title="${L("sky.color_mode")}"><i class="night-day"></i></div></div>` +
    `<div class="login"><div class="vcard cursor-hand">` +
    `<img alt="" src="/public/avatar.png" srcset="/public/avatar@2x.png 2x" class="avatar avatar-96 photo avatar-default" height="96" width="96">` +
    `<span class="name">${title} </span><span class="caret"></span></div>` +
    `<div class="login-main"><div class="user-type">${L("sky.welcome")}</div><div class="operation">` +
    `<a href="/about">${L("sky.about")}</a><a href="/admin/login">Login&nbsp;<i class="skyscraper-icons-sign-in"></i></a>` +
    `</div></div></div></div></div></header>`
  );
}

// Sidebar nav tree, DOM contract ported from themes/skyscraper/SidebarMenu.tsx:
//   ul#menu-main.menu > li.menu-item(.menu-item-has-children) > a (+ ul.sub-menu)
// Parent rows are non-navigating toggles; SSR marks `open` when the row or any
// descendant is active so first paint matches the React useState(active||. )
export type SkyItem = {
  id: number | string;
  label: string;
  url: string;
  target?: string;
  children?: SkyItem[];
};

export function sidebarMenu(items: SkyItem[], pathname: string): string {
  const isActive = (url: string) =>
    !!url && (url === pathname || (url !== "/" && pathname.indexOf(url) === 0));
  const descendantActive = (nodes: SkyItem[]): boolean =>
    nodes.some((n) => isActive(n.url) || (n.children ? descendantActive(n.children) : false));

  const renderItems = (nodes: SkyItem[], depth: number): string =>
    nodes
      .map((it) => {
        const kids = it.children || [];
        const has = kids.length > 0;
        const active = isActive(it.url);
        const open = has && (active || descendantActive(kids));
        const cls = [
          "menu-item",
          has ? "menu-item-has-children" : "",
          active ? "is-active current-menu-item" : "",
          open ? "open" : "",
          `depth-${depth}`,
        ]
          .filter(Boolean)
          .join(" ");
        const anchor = has
          ? `<a>${esc(it.label)}<i class="skyscraper-icons-right"></i></a>`
          : `<a href="${esc(it.url)}"${
              it.target && it.target !== "_self"
                ? ` target="${esc(it.target)}" rel="noopener"`
                : ""
            }>${esc(it.label)}</a>`;
        const sub = has ? `<ul class="sub-menu">${renderItems(kids, depth + 1)}</ul>` : "";
        return `<li class="${cls}">${anchor}${sub}</li>`;
      })
      .join("");

  return (
    `<div class="widget widget_nav_menu"><div class="menu-main-container"><ul id="menu-main" class="menu">` +
    renderItems(items, 0) +
    `</ul></div></div>`
  );
}

export function tagCloud(tags: TaxRef[], t?: Translate): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  return (
    `<section class="widget widget_tag_cloud"><h4 class="widget-title">${L("sidebar.tags")}</h4><div class="tagcloud">` +
    tags
      .slice(0, 18)
      .map((t, i) => {
        const type = i < 2 ? 3 : i < 12 ? 2 : 1;
        const icon = type === 3 ? "fire" : type === 2 ? "seeding" : "snow";
        return (
          `<a class="pf-tag-cloud-link" data-tag-type="${type}" href="${esc(t.url)}">` +
          `<span class="tag-link-name">${esc(t.name)}</span>` +
          `<span class="tag-link-count"><i class="skyscraper-icons-${icon}"></i></span></a>`
        );
      })
      .join("") +
    `</div></section>`
  );
}

export function blogStats(
  c: { posts: number; comments: number; tags: number; categories: number },
  t?: Translate,
): string {
  const L = (k: string, v?: Record<string, string | number>) =>
    t ? t(k, v) : makeT(DEFAULT_LOCALE)(k, v);
  return (
    `<section class="widget widget_blogstat"><h4 class="widget-title">${L("sky.stats")}</h4>` +
    `<ul style="list-style-type:initial;color:#738192">` +
    `<li>${L("sky.stats_posts", { n: c.posts })}</li>` +
    `<li>${L("sky.stats_comments", { n: c.comments })}</li>` +
    `<li>${L("sky.stats_tags", { n: c.tags })}</li>` +
    `<li>${L("sky.stats_cats", { n: c.categories })}</li>` +
    `</ul></section>`
  );
}

export function popularWidget(posts: PostView[], t?: Translate): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  return (
    `<section class="widget widget_pf_post_list_widget"><h4 class="widget-title">${L("sky.popular")}</h4><ul>` +
    posts
      .map(
        (p) =>
          `<li><div class="post-thumbnail-wrapper"><a class="post-thumbnail" href="${esc(p.url)}">` +
          `<img src="${esc(p.featuredImage ?? "")}" alt="${esc(p.title)}" loading="lazy" crossorigin="anonymous"></a></div>` +
          `<div class="infos"><a class="title" href="${esc(p.url)}">${esc(p.title)}</a>` +
          `<div class="metas"><span class="reads"><i class="skyscraper-icons-book-reader"></i>${p.views ?? 0}</span></div></div></li>`,
      )
      .join("") +
    `</ul></section>`
  );
}

export function footerHtml(settings: Record<string, any>, widgetsHtml = ""): string {

    const POLICE_ICON = "/theme-assets/skyscraper/police_icon.png";
  const icp = settings.icpNumber
    ? `<div class="links"><a href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer">` +
      `<img src="${POLICE_ICON}" alt=""><span>&nbsp;&nbsp;${esc(settings.icpNumber)} </span></a></div>`
    : "";
  return `<footer>${widgetsHtml}<div class="pagenav is-empty"></div><div class="copyright">${esc(settings.footerText ?? "")}</div>${icp}</footer>`;
}

// ----------------------------------------------------------- widget areas

const waLink = "color:var(--text);text-decoration:none;font-size:.9rem;line-height:1.5;";
const waRow = "display:flex;align-items:baseline;justify-content:space-between;gap:.6rem;padding:.35rem 0;";
const waDim = "color:var(--muted);font-size:.75rem;white-space:nowrap;";

function waShell(w: { id: number; type: string; title: string }, body: string): string {
  const title = w.title
    ? `<h3 style="font-size:.8rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 .75rem">${esc(w.title)}</h3>`
    : "";
  return (
    `<section class="oboe-widget" data-widget="${esc(w.type)}" style="background:var(--surface);border:var(--border-width) solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem">` +
    title + body + `</section>`
  );
}

/**
 * Render resolved DB widgets for one theme area — pixel port of
 * components/shared/WidgetArea.tsx (inline-style variant, no utility framework).
 * `wrapClass` supplies the theme wrapper (sk-widget-area / sk-footer-widgets).
 */
export function widgetAreaHtml(
  items: import("./widgets.js").ResolvedWidget[],
  wrapClass: string,
): string {
  if (!items.length) return "";
  const wrapStyle =
    wrapClass === "sk-widget-area" ? ' style="display:flex;flex-direction:column;gap:1.5rem"' : "";
  return `<div class="${wrapClass}"${wrapStyle}>${items.map(widgetBody).join("")}</div>`;
}

function widgetBody(w: import("./widgets.js").ResolvedWidget): string {
  const cfg = w.config;
  const data = (w.data ?? []) as any[];

  switch (w.type) {
    case "recent-posts":
      return waShell(
        w,
        `<ul style="list-style:none;padding:0;margin:0">` +
          data
            .map((p) => {
              const thumb =
                cfg.showThumb && p.featuredImage
                  ? `<img src="${esc(p.featuredImage)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:8px;flex-shrink:0">`
                  : "";
              const date =
                cfg.showDate && p.publishedAt
                  ? `<span style="${waDim}">${esc(new Date(p.publishedAt).toISOString().slice(5, 10))}</span>`
                  : "";
              return `<li style="${waRow}">${thumb}<a href="${esc(p.url)}" style="${waLink}flex:1">${esc(p.title)}</a>${date}</li>`;
            })
            .join("") +
          `</ul>`,
      );

    case "popular-posts":
      return waShell(
        w,
        `<ol style="list-style:none;padding:0;margin:0;counter-reset:pp">` +
          data
            .map((p, i) => {
              const views = cfg.showViews ? `<span style="${waDim}">${esc(p.views)}</span>` : "";
              return (
                `<li style="${waRow}"><span style="${waDim}width:1.2em;color:var(--accent)">${i + 1}</span>` +
                `<a href="${esc(p.url)}" style="${waLink}flex:1">${esc(p.title)}</a>${views}</li>`
              );
            })
            .join("") +
          `</ol>`,
      );

    case "categories":
      return waShell(
        w,
        `<ul style="list-style:none;padding:0;margin:0">` +
          data
            .map((c) => {
              const count = cfg.showCount ? `<span style="${waDim}">${esc(c.count)}</span>` : "";
              return `<li style="${waRow}"><a href="${esc(c.url)}" style="${waLink}">${esc(c.name)}</a>${count}</li>`;
            })
            .join("") +
          `</ul>`,
      );

    case "tag-cloud": {
      const max = Math.max(1, ...data.map((t) => Number(t.count)));
      return waShell(
        w,
        `<div style="display:flex;flex-wrap:wrap;gap:.4rem">` +
          data
            .map((t) => {
              const scale = cfg.scale ? 0.78 + (Number(t.count) / max) * 0.5 : 0.85;
              return (
                `<a href="${esc(t.url)}" style="font-size:${scale}rem;color:var(--muted);text-decoration:none;padding:.1rem .45rem;border:1px solid var(--border);border-radius:999px">${esc(t.name)}</a>`
              );
            })
            .join("") +
          `</div>`,
      );
    }

    case "archive":
      return waShell(
        w,
        `<ul style="list-style:none;padding:0;margin:0">` +
          data
            .map((a) => {
              const [y, m] = String(a.period).split("-");
              const href = m ? `/archives?year=${enc(y)}&month=${enc(m)}` : `/archives?year=${enc(y)}`;
              const label = m ? `${y} 年 ${Number(m)} 月` : `${y} 年`;
              const count = cfg.showCount ? `<span style="${waDim}">${esc(a.count)}</span>` : "";
              return `<li style="${waRow}"><a href="${href}" style="${waLink}">${esc(label)}</a>${count}</li>`;
            })
            .join("") +
          `</ul>`,
      );

    case "recent-comments": {
      const len = Number(cfg.excerptLength ?? 48);
      return waShell(
        w,
        `<ul style="list-style:none;padding:0;margin:0">` +
          data
            .map((c) => {
              const text = String(c.content ?? "");
              const excerpt = text.length > len ? text.slice(0, len) + "…" : text;
              return (
                `<li style="padding:.45rem 0;border-bottom:1px solid var(--border)">` +
                `<p style="font-size:.78rem;color:var(--accent);margin:0">${esc(c.authorName)}</p>` +
                `<p style="font-size:.85rem;color:var(--muted);margin:.2rem 0 0;line-height:1.5">${esc(excerpt)}</p></li>`
              );
            })
            .join("") +
          `</ul>`,
      );
    }

    case "stats": {
      const s = (w.data ?? {}) as Record<string, number>;
      const rows: [string, string | number][] = [];
      if (cfg.showPosts) rows.push(["文章", s.posts ?? 0]);
      rows.push(["分类", s.categories ?? 0], ["标签", s.tags ?? 0]);
      if (cfg.showComments) rows.push(["评论", s.comments ?? 0]);
      if (cfg.showViews) rows.push(["总阅读", s.views ?? 0]);
      if (cfg.showRuntime && cfg.since) {
        const days = Math.max(
          0,
          Math.floor((Date.now() - new Date(String(cfg.since)).getTime()) / 86400000),
        );
        rows.push(["已运行", `${days} 天`]);
      }
      return waShell(
        w,
        `<ul style="list-style:none;padding:0;margin:0">` +
          rows
            .map(
              ([k, v]) =>
                `<li style="${waRow}"><span style="font-size:.85rem;color:var(--muted)">${esc(k)}</span><span style="font-size:.85rem;font-weight:600">${esc(v)}</span></li>`,
            )
            .join("") +
          `</ul>`,
      );
    }

    case "search":
      return waShell(
        w,
        `<form action="/search" method="get" style="display:flex;gap:.4rem">` +
          `<input name="q" placeholder="${esc(String(cfg.placeholder ?? "搜索文章…"))}" style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:.45rem .7rem;font-size:.85rem;color:var(--text)">` +
          `<button type="submit" style="background:var(--accent);color:var(--accent-text);border:0;border-radius:var(--radius);padding:.45rem .8rem;font-size:.85rem;cursor:pointer">搜索</button></form>`,
      );

    case "profile": {
      const links = Array.isArray(cfg.links) ? (cfg.links as any[]) : [];
      const avatar = cfg.avatar
        ? `<img src="${esc(String(cfg.avatar))}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;margin:0 auto .6rem;display:block">`
        : "";
      const name = cfg.name ? `<p style="font-weight:600;margin:0">${esc(String(cfg.name))}</p>` : "";
      const role = cfg.role
        ? `<p style="font-size:.78rem;color:var(--accent);margin:.15rem 0 0">${esc(String(cfg.role))}</p>`
        : "";
      const bio = cfg.bio
        ? `<p style="font-size:.85rem;color:var(--muted);line-height:1.6;margin:.6rem 0 0">${esc(String(cfg.bio))}</p>`
        : "";
      const social = links.length
        ? `<div style="display:flex;justify-content:center;gap:.6rem;margin-top:.75rem;flex-wrap:wrap">` +
          links
            .map(
              (l) =>
                `<a href="${esc(l.url ?? "#")}" target="_blank" rel="noopener" style="font-size:.8rem;color:var(--muted)">${esc(l.label ?? "")}</a>`,
            )
            .join("") +
          `</div>`
        : "";
      return waShell(w, `<div style="text-align:center">${avatar}${name}${role}${bio}${social}</div>`);
    }

    case "links": {
      const items = Array.isArray(cfg.items) ? (cfg.items as any[]) : [];
      return waShell(
        w,
        `<ul style="list-style:none;padding:0;margin:0">` +
          items
            .map(
              (l) =>
                `<li style="${waRow}"><a href="${esc(l.url ?? "#")}" target="_blank" rel="noopener" style="${waLink}">${esc(l.label ?? "")}</a></li>`,
            )
            .join("") +
          `</ul>`,
      );
    }

    case "text":
      // Admin-authored (settings:manage); HTML is intentional. Shortcodes are
      // a C-phase dependency — [shortcode] text passes through literally.
      return waShell(
        w,
        `<div class="oboe-widget-text" style="font-size:.9rem;line-height:1.7;color:var(--muted)">${String(cfg.body ?? "")}</div>`,
      );

    default:
      return waShell(w, "");
  }
}

const enc = encodeURIComponent;
