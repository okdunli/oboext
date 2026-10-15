const ALLOWED_TAGS = new Set([
  "p", "span", "br", "hr", "wbr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "mark", "small",
  "sub", "sup", "code", "kbd", "samp", "var", "cite", "q", "abbr", "dfn", "time",
  "div", "section", "article", "aside", "header", "footer", "main", "nav",
  "figure", "figcaption", "blockquote", "pre", "center", "address",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "details", "summary",
  "a", "img", "picture", "source", "iframe",
]);

const DROP_WITH_CONTENT = new Set([
  "script", "style", "noscript", "template", "svg", "math",
  "object", "embed", "applet", "param", "form", "input", "button", "select",
  "option", "optgroup", "textarea", "label", "fieldset", "legend", "datalist",
  "output", "progress", "meter", "canvas", "audio", "video", "track",
]);

const DROP_TAG_ONLY = new Set([
  "link", "meta", "base", "frame", "frameset", "head", "body", "html",
  "basefont", "bgsound", "keygen", "isindex", "command", "menuitem", "map", "area",
  "title", "xmp", "plaintext", "listing",
]);

const GLOBAL_ATTRS = new Set([
  "class", "id", "title", "dir", "lang", "role", "align", "hidden", "tabindex", "style",
]);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "name", "download"]),
  img: new Set(["src", "alt", "width", "height", "loading", "decoding", "srcset", "sizes"]),
  iframe: new Set(["src", "width", "height", "allow", "allowfullscreen", "frameborder", "loading", "title"]),
  source: new Set(["src", "srcset", "type", "media", "sizes"]),
  th: new Set(["colspan", "rowspan", "scope", "abbr"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type", "reversed"]),
  ul: new Set(["type"]),
  li: new Set(["value"]),
  time: new Set(["datetime"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  del: new Set(["cite", "datetime"]),
  ins: new Set(["cite", "datetime"]),
  details: new Set(["open"]),
  b: new Set(), i: new Set(), u: new Set(), s: new Set(),
};

const URL_ATTRS = new Set(["href", "src", "cite", "srcset"]);
const REL_WORDS = new Set(["noopener", "noreferrer", "nofollow", "ugc", "sponsored"]);

const BOOLEAN_ATTRS = new Set([
  "open", "reversed", "hidden", "allowfullscreen", "async", "defer", "default",
  "muted", "playsinline", "controls", "loop", "readonly", "disabled", "checked",
  "selected", "ismap", "novalidate", "formnovalidate", "itemscope", "inert",
]);

const IFRAME_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com",
  "player.bilibili.com", "player.vimeo.com", "vimeo.com", "www.vimeo.com",
]);

const CSS_PROPS = new Set([
  "color", "background-color", "opacity",
  "font", "font-size", "font-weight", "font-style", "font-family",
  "line-height", "letter-spacing", "word-spacing", "text-align", "text-decoration",
  "text-indent", "text-transform", "white-space", "word-break", "overflow-wrap",
  "vertical-align",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-radius", "border-color", "border-width", "border-style",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "display", "float", "clear", "position", "top", "right", "bottom", "left",
  "z-index", "overflow", "overflow-x", "overflow-y", "box-shadow",
  "list-style", "list-style-type", "list-style-position",
  "flex", "flex-direction", "flex-wrap", "justify-content", "align-items",
  "gap", "row-gap", "column-gap", "cursor", "transform", "transition",
  "grid-template-columns", "grid-gap",
]);

const NAMED_ENTITIES: Record<string, string> = {
  colon: ":", tab: "\t", newline: "\n", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function decodeUrlEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => codePointStr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => codePointStr(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => {
      const key = n.toLowerCase();
      return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : m;
    });
}

function codePointStr(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function safeUrl(v: string, allowDataImage: boolean): string | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const decoded = decodeUrlEntities(raw)
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, "")
    .toLowerCase();
  const scheme = decoded.match(/^([a-z][a-z0-9+.-]*):/);
  if (!scheme) return raw;
  const s = scheme[1];
  if (s === "data") {
    if (!allowDataImage) return null;
    return /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/.test(decoded)
      ? raw
      : null;
  }
  if (s === "http" || s === "https" || s === "mailto" || s === "tel" || s === "ftp") return raw;
  return null;
}

function safeSrcset(v: string): string | null {
  const parts = String(v ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    const m = p.match(/^(\S+)(\s+[0-9.]+[xw])?$/i);
    if (!m) return null;
    const url = safeUrl(m[1], true);
    if (!url) return null;
    out.push(url + (m[2] ?? ""));
  }
  return out.join(", ");
}

function sanitizeStyle(v: string): string | null {
  const decls = String(v ?? "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const d of decls) {
    const idx = d.indexOf(":");
    if (idx <= 0) continue;
    const prop = d.slice(0, idx).trim().toLowerCase();
    const val = d.slice(idx + 1).trim();
    if (!CSS_PROPS.has(prop)) continue;
    if (!val || val.length > 200) continue;
    if (/url\(|expression|javascript|vbscript|behavior|@import|\\|<|>|&|\{|\}|;|"|'/i.test(val)) continue;
    if (prop === "position" && !/^(static|relative|absolute|sticky)$/i.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.length ? out.join("; ") : null;
}

const ENTITY_RE = /^&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i;

function escText(s: string): string {
  return s.replace(/[&<>]/g, (ch, off: number) => {
    if (ch === "&" && ENTITY_RE.test(s.slice(off))) return ch;
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;";
  });
}

function escAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch, off: number) => {
    if (ch === "&" && ENTITY_RE.test(s.slice(off))) return ch;
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;";
  });
}

function findTagEnd(src: string, start: number): number {
  let i = start + 1;
  let q: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === ">") {
      return i;
    }
    i++;
  }
  return -1;
}

const TAG_NAME_RE = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function rebuildTag(name: string, attrText: string, closing: boolean): string {
  const tag = name.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return "";
  if (closing) return `</${tag}>`;

  const attrs: string[] = [];
  let iframeSrcOk = false;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let relWords = new Set<string>();
  let targetBlank = false;
  while ((m = ATTR_RE.exec(attrText))) {
    const an = m[1].toLowerCase();
    const av = m[2] ?? m[3] ?? m[4] ?? "";
    if (an.startsWith("on")) continue;
    if (BOOLEAN_ATTRS.has(an) && (!av || /^(true|false|)$/i.test(av.trim()))) {
      attrs.push(an);
      continue;
    }
    const tagAllowed = TAG_ATTRS[tag];
    if (!GLOBAL_ATTRS.has(an) && !tagAllowed?.has(an) && !an.startsWith("data-") && !an.startsWith("aria-")) {
      continue;
    }
    if (an === "style") {
      const css = sanitizeStyle(av);
      if (css) attrs.push(`style="${escAttr(css)}"`);
      continue;
    }
    if (an === "target") {
      if (/^_blank$/i.test(av.trim())) {
        targetBlank = true;
        attrs.push('target="_blank"');
      }
      continue;
    }
    if (an === "rel") {
      for (const w of av.split(/\s+/)) {
        const lw = w.toLowerCase();
        if (REL_WORDS.has(lw)) relWords.add(lw);
      }
      continue;
    }
    if (tag === "iframe" && an === "src") {
      let host: string;
      try {
        host = new URL(av.trim()).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!IFRAME_HOSTS.has(host)) continue;
      iframeSrcOk = true;
      attrs.push(`src="${escAttr(av.trim())}"`);
      continue;
    }
    if (URL_ATTRS.has(an)) {
      const url = safeUrl(av, an === "src" || an === "srcset");
      if (!url) continue;
      attrs.push(`${an}="${escAttr(url)}"`);
      continue;
    }
    if (an === "srcset") {
      const ss = safeSrcset(av);
      if (ss) attrs.push(`srcset="${escAttr(ss)}"`);
      continue;
    }
    if (tag === "iframe" && (an === "allowfullscreen" || an === "loading" || an === "title" || an === "width" || an === "height" || an === "allow" || an === "frameborder")) {
      attrs.push(`${an}="${escAttr(av)}"`);
      continue;
    }
    if (an === "width" || an === "height") {
      if (/^\d{1,5}$/.test(av.trim())) attrs.push(`${an}="${av.trim()}"`);
      continue;
    }
    if (an === "loading" || an === "decoding") {
      const lv = av.trim().toLowerCase();
      if (lv === "lazy" || lv === "eager" || lv === "async" || lv === "sync") {
        attrs.push(`${an}="${lv}"`);
      }
      continue;
    }
    attrs.push(`${an}="${escAttr(av)}"`);
  }
  if (targetBlank) {
    relWords.add("noopener");
    relWords.add("noreferrer");
  }
  if (relWords.size) attrs.push(`rel="${[...relWords].sort().join(" ")}"`);
  if (tag === "iframe") {
    if (!iframeSrcOk) return "";
    attrs.push('sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"');
  }
  return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
}

function findCloseTag(src: string, from: number, tag: string): number {
  const re = new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi");
  re.lastIndex = from;
  const m = re.exec(src);
  return m ? m.index : -1;
}

export function sanitizeHtml(input: string): string {
  const src = String(input ?? "");
  if (!src) return "";
  let out = "";
  let i = 0;
  let iframeOpen = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out += escText(src.slice(i));
      break;
    }
    if (lt > i) out += escText(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    const closeIdx = findTagEnd(src, lt);
    if (closeIdx < 0) {
      out += escText(src.slice(lt));
      break;
    }
    const raw = src.slice(lt, closeIdx + 1);
    const nameM = TAG_NAME_RE.exec(raw);
    if (!nameM) {
      out += escText("<");
      i = lt + 1;
      continue;
    }
    const closing = /^<\s*\//.test(raw);
    const name = nameM[1].toLowerCase();
    const attrText = raw.slice(nameM[0].length).replace(/\/?\s*>$/, "");

    if (DROP_WITH_CONTENT.has(name)) {
      const end = findCloseTag(src, closeIdx + 1, name);
      i = end < 0 ? src.length : src.indexOf(">", end) + 1;
      continue;
    }
    if (DROP_TAG_ONLY.has(name)) {
      i = closeIdx + 1;
      continue;
    }
    const rebuilt = rebuildTag(name, attrText, closing);
    if (name === "iframe") {
      if (closing) {
        if (iframeOpen > 0) {
          iframeOpen--;
          out += "</iframe>";
        }
      } else if (rebuilt) {
        iframeOpen++;
        out += rebuilt;
      }
      i = closeIdx + 1;
      continue;
    }
    if (rebuilt) out += rebuilt;
    i = closeIdx + 1;
  }
  return out;
}
