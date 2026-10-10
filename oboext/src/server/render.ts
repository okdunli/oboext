/**
 * Server-side HTML builders for the skyscraper theme — a straight port of
 * tools/gen.mjs's pure functions, but fed by LIVE PostView rows (camelCase,
 * permalink-aware .url) instead of a build-time JSON snapshot.
 *
 * Everything here returns trusted strings assembled from escaped fields;
 * block "html" content is author-trusted by design (same contract as the
 * original serializeBlocks). Page loaders wrap the final strings in raw()
 * so the rosefd template plugin can emit them unescaped.
 */
import type { Block } from "./schema.js";
import type { PostView, TaxRef } from "./queries.js";

export const RAW_KEY = "__rvraw";
export type RawHtml = { __rvraw: string; __rvhead?: 1 };
export const raw = (html: string): RawHtml => ({
  __rvraw: html,
  toString() {
    return "";
  },
});
export const rawHead = (html: string): RawHtml => ({
  __rvraw: html,
  __rvhead: 1,
  toString() {
    return html;
  },
});
export const isRaw = (v: unknown): v is RawHtml =>
  typeof v === "object" && v !== null && typeof (v as any)[RAW_KEY] === "string";

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
      return b.html;
    default:
      return "";
  }
}
const serializeBlocks = (blocks: Block[] | null | undefined) =>
  !blocks || !blocks.length ? "" : blocks.map(renderBlock).join("\n");

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

/** blocks -> heading ids -> highlight. No brace mangling: output travels via
 *  raw() at runtime, never through the template parser. */
export function buildPostBody(p: PostView): string {
  const blocks = (p.content ?? []) as Block[];
  return highlightCodeBlocks(addHeadingIds(serializeBlocks(blocks), p.slug));
}

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

export function postCard(p: PostView, award = 0): string {
  const img = p.featuredImage
    ? `<a class="post-thumbnail-wrapper" href="${esc(p.url)}"><img src="${esc(p.featuredImage)}" crossorigin="anonymous"></a>`
    : `<a class="post-thumbnail-wrapper" href="${esc(p.url)}"></a>`;
  return (
    `<div class="${CARD_COLS}"><div class="post-card">` +
    (award ? awardBadge(award) : "") +
    `<div class="title"><span>${esc(p.title)}</span></div>` +
    img +
    `<div class="metas"><time class="time">${fmtDate(p.publishedAt)}</time>` +
    `<div class="info">` +
    `<span class="reads" data-toggle="tooltip" title="已读"><i class="skyscraper-icons-book-reader"></i>${p.views ?? 0}</span>` +
    `<span class="likes" data-toggle="tooltip" title="点赞"><i class="skyscraper-icons-heart"></i>${p.likes ?? 0}</span>` +
    `<span class="comments" data-toggle="tooltip" title="评论"><i class="skyscraper-icons-comment"></i>${p.commentsCount ?? 0}</span>` +
    `</div><a class="read-more" href="${esc(p.url)}">阅读全文</a></div></div></div>`
  );
}

export function nestedCard(p: PostView): string {
  const img = p.featuredImage
    ? `<img src="${esc(p.featuredImage)}" crossorigin="anonymous">`
    : "";
  return (
    `<div class="post-card-nested-col"><div class="post-card is-nested">` +
    `<div class="title"><span>${esc(p.title)}</span></div>` +
    `<a class="post-thumbnail-wrapper" href="${esc(p.url)}">${img}</a>` +
    `<div class="metas"><time class="time">${fmtDate(p.publishedAt)}</time>` +
    `<div class="info">` +
    `<span class="reads" data-toggle="tooltip" title="已读"><i class="skyscraper-icons-book-reader"></i>${p.views ?? 0}</span>` +
    `<span class="likes" data-toggle="tooltip" title="点赞"><i class="skyscraper-icons-heart"></i>${p.likes ?? 0}</span>` +
    `<span class="comments" data-toggle="tooltip" title="评论"><i class="skyscraper-icons-comment"></i>${p.commentsCount ?? 0}</span>` +
    `</div><a class="read-more" href="${esc(p.url)}">阅读全文</a></div></div></div>`
  );
}

export const section = (title: string, inner: string): string =>
  `<div class="clearfix"><div class="pf-modal-title"><span class="title-text">${title}</span></div>${inner}</div>`;

export const cardRow = (items: PostView[], awards = false): string =>
  items.length === 0
    ? '<div class="sk-empty">暂无内容</div>'
    : `<div class="row post-card-row">${items.map((p, i) => postCard(p, awards ? i + 1 : 0)).join("")}</div>`;

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

export function shareBar(p: PostView): string {
  const likes = p.likes ?? 0;
  return (
    `<div class="share-modal" data-post-id="${p.id}" data-likes="${likes}"` +
    ` data-excerpt="${esc(p.excerpt || "")}" data-thumb="${esc(p.featuredImage || "")}">` +
    `<button type="button" class="image">${ICON_IMAGE}</button>` +
    `<button type="button" class="likes">${ICON_WEIBO}</button>` +
    `<button type="button" class="qq">${ICON_QQ}</button>` +
    `<button type="button" class="qzone">${ICON_QZONE}</button>` +
    `<button type="button" class="likes -o">${ICON_HEART}</button> ${likes}</div>`
  );
}

export function postHead(p: PostView, siteTitle: string, siteDescription: string, origin: string): string {
  const fullTitle = `${p.seoTitle || p.title} - ${siteTitle}`;
  const desc = p.seoDescription || p.excerpt || siteDescription;
  const url = `${origin}${p.url}`;
  const author = p.author?.name;
  const iso = (v: Date | string | null | undefined) => new Date(v ?? p.publishedAt!).toISOString();
  return [
    `<title>${esc(fullTitle)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<meta name="robots" content="index, follow">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:title" content="${esc(fullTitle)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    p.featuredImage ? `<meta property="og:image" content="${esc(p.featuredImage)}">` : "",
    `<meta property="og:type" content="article">`,
    `<meta property="article:published_time" content="${iso(p.publishedAt)}">`,
    `<meta property="article:modified_time" content="${iso(p.updatedAt || p.publishedAt)}">`,
    author ? `<meta property="article:author" content="${esc(author)}">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(fullTitle)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    p.featuredImage ? `<meta name="twitter:image" content="${esc(p.featuredImage)}">` : "",
  ].filter(Boolean).join("");
}

export function postPage(p: PostView, related: PostView[]): string {
  const cat = p.categories[0] ?? null;
  const meta =
    '<div class="meta">' +
    (cat ? `<span>${esc(cat.name)}</span>` : "") +
    `<span> · ${fmtDate(p.publishedAt)}</span>` +
    `<span> · ${p.views ?? 0} 阅读</span>` +
    `<span> · ${p.commentsCount ?? 0} 评论</span></div>`;
  const bodyHtml = buildPostBody(p);
  const headings = extractHeadings(bodyHtml);
  const toc = headings.length
    ? '<div class="sk-toc"><div class="toc-title">目录</div><ul>' +
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
  return (
    '<div class="sk-postpage">' +
    `<div class="sk-crumbs"><a href="/">首页</a> / <a href="/blog">全部文章</a> / <span>${esc(p.title)}</span></div>` +
    '<article class="post-wrapper" id="post-body">' +
    meta +
    `<h1>${esc(p.title)}</h1>` +
    (p.excerpt ? `<p class="sk-muted">${esc(p.excerpt)}</p>` : "") +
    toc +
    `<div class="post-content prose-cms">${bodyHtml}</div>` +
    tags +
    shareBar(p) +
    '<div class="post-nav"><a href="/blog">← 返回列表</a></div>' +
    "</article>" +
    '<section class="sk-section"><h2 class="title_style_01">相关文章</h2>' +
    cardRow(related, false) +
    "</section>" +
    '<section class="sk-section sk-comments"><h2 class="title_style_01">评论</h2>' +
    '<div class="sf-comment-close">加载评论中…</div></section>' +
    "</div>"
  );
}

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
function heroMeta(p: PostView): string {
  const c = p.categories[0] ?? null;
  return (
    `<div class="meta-wrapper"><div class="meta">` +
    (c ? `<div class="taxonomy">${esc(c.name)}</div>` : "") +
    `<a class="title" href="${esc(p.url)}">${esc(p.title)}</a>` +
    `<div class="meta-bottom"><time>${fmtDate(p.publishedAt)}</time>` +
    `<span class="reads">${p.views ?? 0} 阅读</span>` +
    `<span class="comments">${p.commentsCount ?? 0} 条评论</span></div>` +
    `<a class="goto" href="${esc(p.url)}">阅读全文</a></div></div>`
  );
}

export function cardFlip(hero: PostView[]): string {
  if (!hero.length) return "";
  return (
    `<section class="cardFlip" id="cardFlip">` +
    `<div class="background" aria-hidden="true"><div class="default-background"><div class="head-img"><div class="img"></div></div></div></div>` +
    `<div class="slider-wrapper" aria-hidden="true"><div class="cardFlip-slider">` +
    hero.map((p, i) => heroPage(p, i)).join("") +
    `</div></div>` +
    heroMeta(hero[0]) +
    `<div class="navigator"><div class="prev" role="button" tabindex="0" aria-label="上一篇"><i class="skyscraper-icons-arrow-left"></i></div>` +
    `<div class="next" role="button" tabindex="0" aria-label="下一篇"><i class="skyscraper-icons-arrow-left sk-i-flip-x"></i></div></div>` +
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
}): string {
  return (
    '<div class="sk-home">' +
    cardFlip(parts.hero) +
    (parts.cats.length ? scrollCats(parts.cats) : "") +
    section("最新文章", cardRow(parts.latest, false)) +
    (parts.liked.length ? section("大家喜欢", cardRow(parts.liked, true)) : "") +
    (parts.random.length
      ? section("随机文章", `<div class="row post-card-nested-row">${parts.random.map(nestedCard).join("")}</div>`)
      : "") +
    "</div>"
  );
}

export function pager(page: number, totalPages: number, hrefFor: (p: number) => string): string {
  if (totalPages <= 1) return "";
  let html = '<nav class="sk-pager">';
  if (page > 1) html += `<a href="${esc(hrefFor(page - 1))}">‹ 上一页</a>`;
  for (let p = 1; p <= totalPages; p++) {
    html += p === page ? `<em>${p}</em>` : `<a href="${esc(hrefFor(p))}">${p}</a>`;
  }
  if (page < totalPages) html += `<a href="${esc(hrefFor(page + 1))}">下一页 ›</a>`;
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
}): string {
  const showPager = parts.showPager ?? true;
  return (
    '<section class="sk-section sk-list-page">' +
    `<h1 class="title_style_01">${parts.title}</h1>` +
    `<div class="sk-list-sub sk-muted">${parts.sub}</div>` +
    '<div class="clearfix">' +
    cardRow(parts.items, false) +
    "</div>" +
    (showPager ? pager(parts.page, parts.totalPages, parts.hrefFor) : "") +
    (parts.extra ?? "") +
    "</section>"
  );
}

export function topNav(settings: Record<string, any>): string {
  const title = esc(settings.siteTitle ?? "");
  return (
    `<header class="top-nav is-sticky">` +
    `<div class="sidebar-btn" role="button" tabindex="0" aria-label="打开侧栏"><i class="skyscraper-icons-bread"></i><i class="skyscraper-icons-cross closeBtn"></i></div>` +
    `<div class="toolbox-btn" role="button" tabindex="0" aria-label="打开工具栏"><i class="skyscraper-icons-cog"></i></div>` +
    `<div class="container"><div class="logo"><center><a aria-label="${title}" href="/"><div class="sk-logo">${title}</div></a></center></div>` +
    `<div class="toolbox"><div class="return-btn"><i class="skyscraper-icons-arrow-left"></i></div>` +
    `<div class="search sk-live-search"><i class="skyscraper-icons-search"></i>` +
    `<form role="search" action="/search" method="get"><input id="pf_header_search" type="search" placeholder="搜索您想要的..." autocomplete="off" name="q" value=""></form></div>` +
    `<div class="color-switcher-wrapper"><div class="mobile-button show-on-desktop" title="色彩模式"><i class="night-day"></i></div></div>` +
    `<div class="login"><div class="vcard cursor-hand">` +
    `<img alt="" src="/public/avatar.png" srcset="/public/avatar@2x.png 2x" class="avatar avatar-96 photo avatar-default" height="96" width="96">` +
    `<span class="name">${title} </span><span class="caret"></span></div>` +
    `<div class="login-main"><div class="user-type">欢迎光临</div><div class="operation">` +
    `<a href="/about">关于我</a><a href="/admin/login">Login&nbsp;<i class="skyscraper-icons-sign-in"></i></a>` +
    `</div></div></div></div></div></header>`
  );
}

export function sidebarMenu(active: "home" | "blog" = "home"): string {
  const cls = (on: boolean) =>
    on ? "menu-item is-active current-menu-item depth-0" : "menu-item depth-0";
  return (
    `<div class="widget widget_nav_menu"><div class="menu-main-container"><ul id="menu-main" class="menu">` +
    `<li class="${cls(active === "home")}"><a href="/">首页</a></li>` +
    `<li class="${cls(active === "blog")}"><a href="/blog">所有文章</a></li>` +
    `</ul></div></div>`
  );
}

export function tagCloud(tags: TaxRef[]): string {
  return (
    `<section class="widget widget_tag_cloud"><h4 class="widget-title">标签</h4><div class="tagcloud">` +
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

export function blogStats(c: { posts: number; comments: number; tags: number; categories: number }): string {
  return (
    `<section class="widget widget_blogstat"><h4 class="widget-title">博客统计</h4>` +
    `<ul style="list-style-type:initial;color:#738192">` +
    `<li>日志总数：${c.posts} 篇</li>` +
    `<li>评论数目：${c.comments} 条</li>` +
    `<li>标签总数：${c.tags} 个</li>` +
    `<li>分类总数：${c.categories} 个</li>` +
    `</ul></section>`
  );
}

export function popularWidget(posts: PostView[]): string {
  return (
    `<section class="widget widget_pf_post_list_widget"><h4 class="widget-title">最受欢迎</h4><ul>` +
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

export function footerHtml(settings: Record<string, any>): string {
  return `<footer><div class="pagenav is-empty"></div><div class="copyright">${esc(settings.footerText ?? "")}</div></footer>`;
}
