/**
 * `[tag]` macros expanded at render time — port of oboext lib/shortcodes.ts.
 * Plugins register custom tags via registerShortcode() (e.g. friend-links);
 * `[[tag]]` double brackets survive as literal text. Built-ins cover the
 * original set (alert/button/details/columns/…/gallery/posts/toc/year/site).
 */
import { applyFilters, HOOKS } from "./hooks.js";

export type ShortcodeAttrs = Record<string, string>;

export interface ShortcodeResolvers {
  media?: (ids: number[]) => Promise<{ id: number; url: string; alt?: string | null }[]>;
  posts?: (opts: {
    limit: number;
    category?: string;
    tag?: string;
    order?: string;
  }) => Promise<{
    title: string;
    slug: string;
    url: string;
    excerpt?: string | null;
    publishedAt?: Date | null;
  }[]>;
}

export interface ShortcodeContext {
  kind?: string;
  postId?: number;
  slug?: string;
  siteTitle?: string;
  resolvers?: ShortcodeResolvers;
}

export interface ShortcodeDefinition {
  name: string;
  description?: string;
  example?: string;
  render: (
    attrs: ShortcodeAttrs,
    inner: string,
    ctx: ShortcodeContext,
  ) => string | Promise<string>;
}

const globalForShortcodes = globalThis as unknown as {
  __oboeShortcodes?: Map<string, ShortcodeDefinition>;
};

function store(): Map<string, ShortcodeDefinition> {
  if (!globalForShortcodes.__oboeShortcodes) {
    globalForShortcodes.__oboeShortcodes = new Map();
  }
  return globalForShortcodes.__oboeShortcodes;
}

export function registerShortcode(def: ShortcodeDefinition): void {
  store().set(def.name.toLowerCase(), def);
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Parse `type="warn" title=Hello flag` into an attribute map. */
export function parseAttrs(raw: string): ShortcodeAttrs {
  const attrs: ShortcodeAttrs = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s\]]+))|([\w:-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m[1]) {
      attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
    } else if (m[6]) {
      attrs[m[6].toLowerCase()] = "true";
    }
  }
  return attrs;
}

const ESCAPE_TOKEN = "\u0000OBOE_SC\u0000";

/**
 * Expand every registered shortcode inside an HTML string.
 * Runs up to `depth` passes so a shortcode may emit another shortcode.
 */
export async function renderShortcodes(
  html: string,
  ctx: ShortcodeContext = {},
  depth = 3,
): Promise<string> {
  if (!html) return html;
  const registry = applyFilters(HOOKS.shortcodes, { shortcodes: store() }).shortcodes;
  if (!registry.size) return html;

  const names = [...registry.keys()]
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  let out = html.replace(
    new RegExp(`\\[\\[(${names})([^\\]]*)\\]\\]`, "gi"),
    (_all, n: string, a: string) => `${ESCAPE_TOKEN}${n}${a}${ESCAPE_TOKEN}`,
  );

  const pattern = new RegExp(
    `\\[(${names})((?:[^\\]]|\\](?=\\s*\\}))*?)\\s*(?:\\/\\])|\\[(${names})([^\\]]*)\\]([\\s\\S]*?)\\[\\/\\3\\]|\\[(${names})([^\\]]*)\\]`,
    "gi",
  );

  for (let pass = 0; pass < depth; pass++) {
    const matches: { full: string; name: string; attrs: string; inner: string; index: number }[] =
      [];
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(out))) {
      const name = (m[1] ?? m[3] ?? m[6] ?? "").toLowerCase();
      const attrs = m[2] ?? m[4] ?? m[7] ?? "";
      const inner = m[5] ?? "";
      matches.push({ full: m[0], name, attrs, inner, index: m.index });
    }
    if (!matches.length) break;

    for (let i = matches.length - 1; i >= 0; i--) {
      const item = matches[i];
      const def = registry.get(item.name);
      let replacement = "";
      if (def) {
        try {
          replacement = await def.render(parseAttrs(item.attrs), item.inner, ctx);
        } catch (err) {
          console.error(`[shortcode] "${item.name}" failed:`, err);
          replacement = "";
        }
      }
      out =
        out.slice(0, item.index) + replacement + out.slice(item.index + item.full.length);
    }
  }

  const restore = new RegExp(`${ESCAPE_TOKEN}([\\s\\S]*?)${ESCAPE_TOKEN}`, "g");
  return out.replace(restore, (_a, body: string) => `[${body}]`);
}

function registerBuiltins() {
  registerShortcode({
    name: "alert",
    description: "彩色提示框",
    example: '[alert type="warn" title="注意"]内容[/alert]',
    render: (a, inner) => {
      const type = (a.type || "info").toLowerCase();
      const palette: Record<string, string> = {
        info: "var(--accent)",
        success: "var(--success)",
        warn: "var(--warning)",
        warning: "var(--warning)",
        danger: "var(--danger)",
        error: "var(--danger)",
      };
      const color = palette[type] ?? "var(--accent)";
      const title = a.title
        ? `<strong style="display:block;margin-bottom:.35rem">${esc(a.title)}</strong>`
        : "";
      return `<div class="oboe-alert" data-type="${esc(type)}" style="border-left:3px solid ${color};background:color-mix(in srgb,${color} 8%,transparent);padding:.85rem 1rem;border-radius:var(--radius);margin:1.25rem 0">${title}<div>${inner}</div></div>`;
    },
  });

  registerShortcode({
    name: "button",
    description: "按钮链接",
    example: '[button href="/about" style="primary"]了解更多[/button]',
    render: (a, inner) => {
      const primary = (a.style || "primary") === "primary";
      const style = primary
        ? "background:var(--accent);color:var(--accent-text);border:1px solid transparent"
        : "background:transparent;color:var(--accent);border:1px solid var(--accent)";
      const target = a.target === "_blank" ? ' target="_blank" rel="noopener"' : "";
      return `<a class="oboe-btn" href="${esc(a.href || "#")}"${target} style="display:inline-flex;align-items:center;gap:.4rem;padding:.5rem 1.1rem;border-radius:var(--radius);font-size:.9rem;font-weight:500;text-decoration:none;${style}">${inner || esc(a.label || "查看")}</a>`;
    },
  });

  registerShortcode({
    name: "details",
    description: "可折叠面板",
    example: '[details title="点击展开"]隐藏内容[/details]',
    render: (a, inner) =>
      `<details class="oboe-details" style="border:1px solid var(--border);border-radius:var(--radius);padding:.75rem 1rem;margin:1.25rem 0"${
        a.open === "true" ? " open" : ""
      }><summary style="cursor:pointer;font-weight:500">${esc(a.title || "详情")}</summary><div style="margin-top:.75rem">${inner}</div></details>`,
  });

  registerShortcode({
    name: "columns",
    description: "多列布局容器，内部配合 [col]",
    example: "[columns cols=2][col]左[/col][col]右[/col][/columns]",
    render: (a, inner) =>
      `<div class="oboe-columns" style="display:grid;gap:1.25rem;grid-template-columns:repeat(${
        Number(a.cols) || 2
      },minmax(0,1fr));margin:1.25rem 0">${inner}</div>`,
  });

  registerShortcode({
    name: "col",
    render: (_a, inner) => `<div class="oboe-col">${inner}</div>`,
  });

  registerShortcode({
    name: "badge",
    description: "行内标记",
    example: '[badge color="var(--success)"]NEW[/badge]',
    render: (a, inner) =>
      `<span class="oboe-badge" style="display:inline-block;padding:.1rem .45rem;border-radius:5px;font-size:.75em;font-weight:600;background:${esc(
        a.color || "var(--accent-soft)",
      )};color:${esc(a.text || "var(--accent)")}">${inner}</span>`,
  });

  registerShortcode({
    name: "kbd",
    description: "键盘按键",
    example: "[kbd]Ctrl + S[/kbd]",
    render: (_a, inner) =>
      `<kbd style="font-family:var(--font-mono);font-size:.85em;padding:.1rem .45rem;border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;background:var(--surface)">${inner}</kbd>`,
  });

  registerShortcode({
    name: "progress",
    description: "进度条",
    example: '[progress value="72" label="完成度"]',
    render: (a) => {
      const v = Math.max(0, Math.min(100, Number(a.value) || 0));
      const label = a.label
        ? `<div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--muted);margin-bottom:.35rem"><span>${esc(
            a.label,
          )}</span><span>${v}%</span></div>`
        : "";
      return `<div class="oboe-progress" style="margin:1rem 0">${label}<div style="height:6px;border-radius:999px;background:var(--border);overflow:hidden"><div style="width:${v}%;height:100%;background:var(--accent)"></div></div></div>`;
    },
  });

  registerShortcode({
    name: "embed",
    description: "自动识别 B 站 / YouTube / 通用 iframe",
    example: '[embed url="https://www.bilibili.com/video/BV1xx"]',
    render: (a) => {
      const url = a.url || a.src || "";
      let src = url;
      const bili = url.match(/bilibili\.com\/video\/(BV[\w]+)/i);
      const yt = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]+)/i);
      if (bili) src = `https://player.bilibili.com/player.html?bvid=${bili[1]}&high_quality=1`;
      else if (yt) src = `https://www.youtube.com/embed/${yt[1]}`;
      const ratio = a.ratio || "56.25%";
      return `<div class="oboe-embed" style="position:relative;padding-bottom:${esc(
        ratio,
      )};height:0;overflow:hidden;border-radius:var(--radius);margin:1.5rem 0"><iframe src="${esc(
        src,
      )}" style="position:absolute;inset:0;width:100%;height:100%;border:0" allowfullscreen loading="lazy"></iframe></div>`;
    },
  });

  registerShortcode({
    name: "video",
    description: "本地/直链视频播放器",
    example: '[video src="/uploads/media/demo.mp4" poster="/uploads/media/p.jpg"]',
    render: (a) =>
      `<video class="oboe-video" src="${esc(a.src || "")}"${
        a.poster ? ` poster="${esc(a.poster)}"` : ""
      } controls${a.loop ? " loop" : ""}${a.muted ? " muted" : ""} style="width:100%;border-radius:var(--radius);margin:1.5rem 0"></video>`,
  });

  registerShortcode({
    name: "audio",
    description: "音频播放器",
    example: '[audio src="/uploads/media/song.mp3"]',
    render: (a) =>
      `<audio class="oboe-audio" src="${esc(a.src || "")}" controls style="width:100%;margin:1.25rem 0"></audio>`,
  });

  registerShortcode({
    name: "linkcard",
    description: "外链卡片",
    example: '[linkcard href="https://example.com" title="标题" desc="描述"]',
    render: (a) =>
      `<a class="oboe-linkcard" href="${esc(a.href || "#")}" target="_blank" rel="noopener" style="display:flex;gap:.9rem;align-items:center;padding:.9rem 1rem;border:1px solid var(--border);border-radius:var(--radius);text-decoration:none;margin:1.25rem 0;background:var(--surface)">${
        a.icon
          ? `<img src="${esc(a.icon)}" alt="" style="width:36px;height:36px;border-radius:8px;object-fit:cover"/>`
          : ""
      }<span style="min-width:0"><strong style="display:block;color:var(--text)">${esc(
        a.title || a.href || "",
      )}</strong><span style="display:block;font-size:.82rem;color:var(--muted)">${esc(
        a.desc || "",
      )}</span></span></a>`,
  });

  registerShortcode({
    name: "gallery",
    description: "媒体库图集",
    example: '[gallery ids="1,2,3" columns="3"]',
    render: async (a, _inner, ctx) => {
      const ids = (a.ids || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length || !ctx.resolvers?.media) return "";
      const items = await ctx.resolvers.media(ids);
      if (!items.length) return "";
      const cols = Number(a.columns) || 3;
      const cells = items
        .map(
          (m) =>
            `<figure style="margin:0"><img src="${esc(m.url)}" alt="${esc(
              m.alt ?? "",
            )}" loading="lazy" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius);display:block"/></figure>`,
        )
        .join("");
      return `<div class="oboe-gallery" style="display:grid;gap:.75rem;grid-template-columns:repeat(${cols},minmax(0,1fr));margin:1.5rem 0">${cells}</div>`;
    },
  });

  registerShortcode({
    name: "posts",
    description: "文章列表",
    example: '[posts count="5" category="notes"]',
    render: async (a, _inner, ctx) => {
      if (!ctx.resolvers?.posts) return "";
      const items = await ctx.resolvers.posts({
        limit: Number(a.count) || 5,
        category: a.category,
        tag: a.tag,
        order: a.order,
      });
      if (!items.length) return "";
      const rows = items
        .map(
          (p) =>
            `<li style="padding:.5rem 0;border-bottom:1px solid var(--border)"><a href="${esc(
              p.url,
            )}" style="color:var(--text);text-decoration:none">${esc(p.title)}</a>${
              p.publishedAt
                ? `<span style="float:right;font-size:.8rem;color:var(--muted)">${new Date(
                    p.publishedAt,
                  )
                    .toISOString()
                    .slice(0, 10)}</span>`
                : ""
            }</li>`,
        )
        .join("");
      return `<ul class="oboe-postlist" style="list-style:none;padding:0;margin:1.25rem 0">${rows}</ul>`;
    },
  });

  registerShortcode({
    name: "toc",
    description: "文内目录占位（由主题在渲染时填充）",
    example: "[toc]",
    render: () => `<div data-oboe-toc="1"></div>`,
  });

  registerShortcode({
    name: "year",
    description: "当前年份",
    example: "[year]",
    render: () => String(new Date().getFullYear()),
  });

  registerShortcode({
    name: "site",
    description: "站点标题",
    example: "[site]",
    render: (_a, _i, ctx) => esc(ctx.siteTitle ?? ""),
  });
}

if (!store().size) registerBuiltins();

/** Explicit initialiser for call sites that must guarantee registration. */
export function ensureShortcodes(): void {
  if (!store().size) registerBuiltins();
}
