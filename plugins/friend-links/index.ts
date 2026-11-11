import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import { HOOKS } from "../../oboext/src/server/hooks.js";
import { registerShortcode, type ShortcodeDefinition } from "../../oboext/src/server/shortcodes.js";
import type { AdminMenuItem } from "../../oboext/src/server/admin-menu.js";
import type { SiteRoutesPayload } from "../../oboext/src/server/virtual-routes.js";
import type { SitemapPayload } from "../../oboext/src/server/sitemap.js";
import { makeT } from "../../oboext/src/server/i18n.js";

export type FriendLink = {
  id: string;
  name: string;
  url: string;
  avatar?: string;
  description?: string;
  group?: string;
  visible?: boolean;
};

type FriendLinkSettings = {
  links: FriendLink[];
  columns: string;
  showDescription: boolean;
  openNewTab: boolean;

  routeEnabled: boolean;

  routePath: string;

  pageTitle: string;
};

function normalizeRoutePath(raw: unknown): string {
  const v = String(raw ?? "links").trim().replace(/^\/+|\/+$/g, "");
  if (!v || v.includes("/")) return "links";
  return v;
}

function readSettings(raw: Record<string, unknown>): FriendLinkSettings {
  const links = Array.isArray(raw.links) ? (raw.links as FriendLink[]) : [];
  return {
    links,
    columns: String(raw.columns ?? "3"),

    showDescription: raw.showDescription !== false,
    openNewTab: raw.openNewTab !== false,
    routeEnabled: raw.routeEnabled === true,
    routePath: normalizeRoutePath(raw.routePath),
    // Empty when unset: the route title falls back to the localized default,
    // so the stored settings never freeze one language into the data.
    pageTitle: String(raw.pageTitle ?? "").trim(),
  };
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
.oboe-fl-wrap{display:grid;gap:6px;margin:24px 0}
.oboe-fl-group{margin:18px 0 4px;font-size:1.02rem;font-weight:700}
.oboe-fl-grid{display:grid;gap:12px}
.oboe-fl-empty{opacity:.6;text-align:center;padding:36px 0}
@media(max-width:640px){.oboe-fl-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
.oboe-fl-card{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:18px 12px 14px;border-radius:14px;background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.22);color:inherit;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
.oboe-fl-card:hover{transform:translateY(-3px);border-color:var(--primary-color,var(--accent,#818cf8));box-shadow:0 6px 18px rgba(0,0,0,.08)}
.oboe-fl-avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid rgba(127,127,127,.25)}
.oboe-fl-fallback{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;background:var(--primary-color,var(--accent,#818cf8));color:#fff}
.oboe-fl-desc{font-size:.78rem;opacity:.65;line-height:1.4;word-break:break-word}
.oboe-fl-btn{margin-top:auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 16px 4px;border-radius:9em;font-size:13px;line-height:1.5;text-decoration:none;color:var(--primary-color,#1f8bff);position:relative;transition:background-color .25s ease;background-color:var(--primary-opacity-2,rgba(31,139,255,.2));background-image:linear-gradient(rgba(255,255,255,0) 65%,rgba(255,255,255,.75));box-shadow:0 0 0 1px #fff inset,0 8px 10px rgba(85,120,161,.05),0 8px 10px var(--primary-opacity-2,rgba(31,139,255,.2)),0 0 5px var(--primary-opacity-2,rgba(31,139,255,.2))}
.oboe-fl-btn:before{content:"";position:absolute;left:.5em;right:.5em;top:0;height:50%;border-radius:9em;background:linear-gradient(rgba(255,255,255,.9),rgba(255,255,255,.3));box-shadow:0 1px #fff inset;pointer-events:none}
.oboe-fl-btn:hover{background-color:var(--primary-opacity-3,rgba(31,139,255,.3))}
.oboe-fl-btn svg{position:relative;z-index:1;width:12px;height:12px;fill:currentColor}
.oboe-fl-btn span{position:relative;z-index:1}
`;

function renderCard(
  link: FriendLink,
  showDescription: boolean,
  openNewTab: boolean,
): string {
  const target = openNewTab ? ' target="_blank" rel="noopener noreferrer"' : "";
  const media = link.avatar
    ? `<img class="oboe-fl-avatar" src="${esc(link.avatar)}" alt="${esc(link.name)}" loading="lazy">`
    : `<span class="oboe-fl-fallback">${esc((link.name || "?").slice(0, 1))}</span>`;
  const desc =
    showDescription && link.description
      ? `<small class="oboe-fl-desc">${esc(link.description)}</small>`
      : "";

  return `<div class="oboe-fl-card">${media}${desc}<a class="oboe-fl-btn" href="${esc(link.url)}"${target}><svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg><span>${esc(link.name)}</span></a></div>`;
}

type RenderAttrs = { group?: string; columns?: string };

function renderLinksHtml(
  s: FriendLinkSettings,
  attrs: RenderAttrs,
  allowEmpty: boolean,
  t: T = makeT("zh-CN"),
): string {

  const groupFilter = (attrs.group ?? "").trim();
  const visible = s.links.filter(
    (l) => l.visible !== false && (!groupFilter || (l.group ?? "") === groupFilter),
  );
  if (visible.length === 0) {
    return allowEmpty
      ? `<style>${STYLE}</style><div class="oboe-fl-wrap"><p class="oboe-fl-empty">${t("plugin.friend_links.wall_empty")}</p></div>`
      : "";
  }

  const wanted = parseInt(attrs.columns || s.columns, 10);
  const cols = Math.min(4, Math.max(1, Number.isFinite(wanted) ? wanted : 3));

  const groups: { name: string; items: FriendLink[] }[] = [];
  const index = new Map<string, number>();
  for (const link of visible) {
    const name = (link.group ?? "").trim();
    const at = index.get(name);
    if (at === undefined) {
      index.set(name, groups.length);
      groups.push({ name, items: [link] });
    } else {
      groups[at].items.push(link);
    }
  }

  const showGroups = groups.length > 1 || groups[0]?.name;
  const body = groups
    .map(
      (g) =>
        (showGroups && g.name
          ? `<h3 class="oboe-fl-group">${esc(g.name)}</h3>`
          : "") +
        `<div class="oboe-fl-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">` +
        g.items.map((l) => renderCard(l, s.showDescription, s.openNewTab)).join("") +
        `</div>`,
    )
    .join("");

  return `<style>${STYLE}</style><div class="oboe-fl-wrap">${body}</div>`;
}

// ------------------------------------------------------- admin panel (port)

// R531: the panel renders in the admin session's language. `t` is the request
// translator handed to the admin.panel filter; the fallback keeps the plugin
// usable (e.g. when a host renders the panel outside the admin loader).
type T = (key: string, vars?: Record<string, string | number>) => string;

function panelRow(l: FriendLink | null, t: T): string {
  const v = l ?? { id: "", name: "", url: "", avatar: "", description: "", group: "", visible: true };
  const field = (key: string, label: string, value: string, extra = "") =>
    `<label class="adm-field" style="margin-bottom:10px;"><span style="display:block;font-size:12px;color:var(--adm-muted);margin-bottom:4px;">${label}</span>` +
    `<input class="adm-input" data-fl-f="${key}" value="${esc(value)}"${extra}></label>`;
  return (
    `<div class="adm-card" style="margin-bottom:10px;padding:12px 14px;" data-fl-row>` +
    `<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">` +
    `<strong style="font-size:13px;">${t("plugin.friend_links.row_title")}</strong><span style="flex:1"></span>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-fl-act="up" title="${t("plugin.friend_links.move_up")}"><span class="adm-ic adm-ic-sm" style="--i:url(/public/icons/arrow-up.svg)"></span></button>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-fl-act="down" title="${t("plugin.friend_links.move_down")}"><span class="adm-ic adm-ic-sm" style="--i:url(/public/icons/arrow-down.svg)"></span></button>` +
    `<button type="button" class="adm-btn adm-btn-danger adm-btn-sm" data-fl-act="del" title="${t("plugin.friend_links.remove")}"><span class="adm-ic adm-ic-sm" style="--i:url(/public/icons/trash-2.svg)"></span></button>` +
    `</div>` +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px;">` +
    field("name", t("plugin.friend_links.name"), v.name) +
    field("url", t("plugin.friend_links.url"), v.url, ' placeholder="https://"') +
    field("avatar", t("plugin.friend_links.avatar"), v.avatar ?? "") +
    field("group", t("plugin.friend_links.group"), v.group ?? "") +
    `</div>` +
    field("description", t("plugin.friend_links.description"), v.description ?? "") +
    `<label class="adm-switch"><span class="t">${t("plugin.friend_links.visible")}</span><input type="checkbox" data-fl-f="visible"${v.visible === false ? "" : " checked"}></label>` +
    `</div>`
  );
}

function panelHtml(s: FriendLinkSettings, t: T): string {
  const rows = s.links.length
    ? s.links.map((l) => panelRow(l, t)).join("")
    : `<div class="adm-empty" style="border:1px dashed var(--adm-border);border-radius:var(--adm-radius);padding:28px 16px;">${t("plugin.friend_links.empty")}</div>`;
  const opt = (value: string, label: string, current: string) =>
    `<option value="${value}"${current === value ? " selected" : ""}>${label}</option>`;
  const sw = (key: string, label: string, desc: string, on: boolean) =>
    `<label class="adm-switch"><span><span class="t">${label}</span><span class="d">${desc}</span></span>` +
    `<input type="checkbox" data-fl-set="${key}"${on ? " checked" : ""}></label>`;
  // R531: the client script is a static file, so the strings it needs travel
  // with the panel markup as a JSON dictionary on the root element.
  const dict = JSON.stringify({
    saving: t("plugin.friend_links.saving"),
    saved: t("plugin.friend_links.saved"),
    save_failed: t("plugin.friend_links.save_failed"),
  });
  return (
    `<div data-fl-panel data-i18n="${esc(dict)}">` +
    `<div class="adm-card" style="margin-bottom:16px;">` +
    `<div class="adm-card-hd"><strong style="font-size:15px;">${t("plugin.friend_links.title")}</strong><span class="spacer" style="flex:1"></span>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-fl-act="add"><span class="adm-ic adm-ic-sm" style="--i:url(/public/icons/plus.svg)"></span>${t("plugin.friend_links.add")}</button>` +
    `<button type="button" class="adm-btn adm-btn-green adm-btn-sm" data-fl-act="save"><span class="adm-ic adm-ic-sm" style="--i:url(/public/icons/save.svg)"></span>${t("plugin.friend_links.save")}</button>` +
    `</div>` +
    `<div class="adm-card-bd"><p class="adm-hint" data-fl-msg style="margin:0 0 12px;min-height:18px;"></p>` +
    `<div data-fl-rows>${rows}</div></div>` +
    `</div>` +
    `<template data-fl-tpl>${panelRow(null, t)}</template>` +
    `<div class="adm-card" style="margin-bottom:16px;">` +
    `<div class="adm-card-hd"><strong style="font-size:15px;">${t("plugin.friend_links.display_title")}</strong></div>` +
    `<div class="adm-card-bd">` +
    `<label class="adm-field"><span style="display:block;font-size:12px;color:var(--adm-muted);margin-bottom:4px;">${t("plugin.friend_links.columns")}</span>` +
    `<select class="adm-select" data-fl-set="columns">${opt("2", t("plugin.friend_links.col2"), s.columns)}${opt("3", t("plugin.friend_links.col3"), s.columns)}${opt("4", t("plugin.friend_links.col4"), s.columns)}</select></label>` +
    sw("showDescription", t("plugin.friend_links.show_description"), t("plugin.friend_links.show_description_d"), s.showDescription) +
    sw("openNewTab", t("plugin.friend_links.new_tab"), t("plugin.friend_links.new_tab_d"), s.openNewTab) +
    `</div></div>` +
    `<div class="adm-card" style="margin-bottom:16px;">` +
    `<div class="adm-card-hd"><strong style="font-size:15px;">${t("plugin.friend_links.route_title")}</strong></div>` +
    `<div class="adm-card-bd">` +
    sw("routeEnabled", t("plugin.friend_links.route_enabled"), t("plugin.friend_links.route_enabled_d"), s.routeEnabled) +
    `<label class="adm-field"><span style="display:block;font-size:12px;color:var(--adm-muted);margin-bottom:4px;">${t("plugin.friend_links.route_path")}</span>` +
    `<input class="adm-input" data-fl-set="routePath" value="${esc(s.routePath)}" placeholder="links"></label>` +
    `<label class="adm-field" style="margin-bottom:0;"><span style="display:block;font-size:12px;color:var(--adm-muted);margin-bottom:4px;">${t("plugin.friend_links.page_title")}</span>` +
    `<input class="adm-input" data-fl-set="pageTitle" value="${esc(s.pageTitle)}"></label>` +
    `</div></div>` +
    `</div>`
  );
}

const PANEL_SCRIPT_SRC = "/plugin-assets/friend-links/panel.js";

export default definePlugin({
  slug: "friend-links",

  setup({ settings, addFilter, HOOKS }) {
    const definition: ShortcodeDefinition = {
      name: "friendlinks",
      description: "友情链接卡片墙",
      example: '[friendlinks group="朋友们" columns="4"]',
      render: (attrs) => renderLinksHtml(readSettings(settings), attrs, false),
    };

    registerShortcode(definition);

    addFilter<SiteRoutesPayload>(HOOKS.siteRoutes, (payload) => {
      if (payload.route) return payload;
      const s = readSettings(settings);
      if (!s.routeEnabled) return payload;
      const t = makeT(payload.locale ?? "zh-CN");
      if (payload.segments.length === 1 && payload.segments[0] === s.routePath) {
        payload.route = {
          title: s.pageTitle || t("plugin.name.friend_links"),
          html: renderLinksHtml(s, {}, true, t),
          path: "/" + s.routePath,
        };
      }
      return payload;
    });

    addFilter<SitemapPayload>(HOOKS.sitemapUrls, (payload) => {
      const s = readSettings(settings);
      if (s.routeEnabled) {
        payload.entries.push({
          loc: `${payload.base}/${s.routePath}`,
          changefreq: "weekly",
          priority: "0.3",
        });
      }
      return payload;
    });

    addFilter<{ slug: string; html: string; scriptSrc: string; t: T }>(HOOKS.adminPanel, (payload) => {
      if (payload.slug !== "friend-links") return payload;
      const s = readSettings(settings);
      payload.html = panelHtml(s, payload.t ?? makeT("zh-CN"));
      payload.scriptSrc = PANEL_SCRIPT_SRC;
      return payload;
    });

    addFilter<{ items: AdminMenuItem[] }>(HOOKS.adminMenu, (payload) => {
      payload.items.push({
        href: "/admin/plugins/friend-links",
        // R531: "@" marks a catalog key the shell resolves in the request's
        // language (menuLabelText) instead of a literal label.
        label: "@plugin.name.friend_links",
        glyph: "link",
      });
      return payload;
    });
  },
});
