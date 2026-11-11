import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import type { AdminMenuItem } from "../../oboext/src/server/admin-menu.js";
import { makeT } from "../../oboext/src/server/i18n.js";

type Settings = {
  /** Display order — index 0 is shown first. */
  ids: number[];

  includeHome?: boolean;
};

function readSettings(raw: Record<string, unknown>): Settings {
  return {
    ids: Array.isArray(raw.ids)
      ? (raw.ids as unknown[]).filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0,
        )
      : [],
    includeHome: raw.includeHome !== false,
  };
}

function ic(n: string): string {
  return '<span class="adm-ic adm-ic-sm" style="--i:url(/public/icons/' + n + '.svg)"></span>';
}

// ------------------------------------------------------- admin panel (port)

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Escape a JSON payload for a double-quoted HTML attribute. */
function escAttr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pinnedRowTpl(t: T): string {
  return (
    `<div class="adm-card" style="margin-bottom:8px;padding:10px 12px;" data-sp-prow>` +
    `<div style="display:flex;align-items:center;gap:8px;">` +
    `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">` +
    `<button type="button" class="adm-iconbtn" data-sp-act="up" title="${t("plugin.sticky_posts.move_up")}">${ic("arrow-up")}</button>` +
    `<input class="adm-input" data-sp-pos type="number" min="1" style="width:56px;text-align:center;" title="${t("plugin.sticky_posts.pos_title")}">` +
    `<button type="button" class="adm-iconbtn" data-sp-act="down" title="${t("plugin.sticky_posts.move_down")}">${ic("arrow-down")}</button>` +
    `</div>` +
    `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;" data-sp-title></span>` +
    `<span class="adm-tag" data-sp-status style="flex-shrink:0;"></span>` +
    `<span class="adm-hint" style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;flex-shrink:0;" data-sp-id></span>` +
    `<span class="adm-hint" style="margin:0;width:88px;text-align:right;flex-shrink:0;" data-sp-date></span>` +
    `<button type="button" class="adm-iconbtn danger" data-sp-act="unpin" title="${t("plugin.sticky_posts.unpin")}">${ic("pin-off")}</button>` +
    `</div></div>`
  );
}

function catalogueRowTpl(t: T): string {
  return (
    `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--adm-border);" data-sp-crow>` +
    `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;" data-sp-title></span>` +
    `<span class="adm-tag" data-sp-status style="flex-shrink:0;"></span>` +
    `<span class="adm-hint" style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;flex-shrink:0;" data-sp-id></span>` +
    `<span class="adm-hint" style="margin:0;width:88px;text-align:right;flex-shrink:0;" data-sp-date></span>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-sp-act="pin" style="flex-shrink:0;">${ic("pin")}${t("plugin.sticky_posts.pin")}</button>` +
    `</div>`
  );
}

function panelHtml(s: Settings, t: T): string {
  const dict = JSON.stringify({
    untitled: t("plugin.sticky_posts.untitled"),
    st_published: t("plugin.sticky_posts.st_published"),
    st_draft: t("plugin.sticky_posts.st_draft"),
    empty_pinned: t("plugin.sticky_posts.empty_pinned"),
    no_match: t("plugin.sticky_posts.no_match"),
    all_pinned: t("plugin.sticky_posts.all_pinned"),
    more_state: t("plugin.sticky_posts.more_state"),
    saving: t("plugin.sticky_posts.saving"),
    saved: t("plugin.sticky_posts.saved"),
    save_failed: t("plugin.sticky_posts.save_failed"),
    loading: t("plugin.sticky_posts.loading"),
    count: t("plugin.sticky_posts.count"),
  });
  return (
    `<div data-sp-panel data-i18n="${escAttr(dict)}">` +
    `<div class="adm-card" style="margin-bottom:16px;">` +
    `<div class="adm-card-hd"><strong style="font-size:15px;">${t("plugin.sticky_posts.title")}</strong>` +
    `<span class="spacer" style="flex:1"></span>` +
    `<span class="adm-hint" style="margin:0;" data-sp-state></span></div>` +
    `<div class="adm-card-bd">` +
    `<p class="adm-hint" style="margin:0 0 12px;">${t("plugin.sticky_posts.hint")}</p>` +
    `<label class="adm-switch" style="margin-bottom:12px;"><span><span class="t">${t("plugin.sticky_posts.include_home")}</span><span class="d">${t("plugin.sticky_posts.include_home_d")}</span></span>` +
    `<input type="checkbox" data-sp-set="includeHome"${s.includeHome ? " checked" : ""}></label>` +
    `<div data-sp-pinned></div>` +
    `</div></div>` +
    `<div class="adm-card" style="margin-bottom:16px;">` +
    `<div class="adm-card-hd"><strong style="font-size:15px;">${t("plugin.sticky_posts.all_title")}</strong>` +
    `<span class="spacer" style="flex:1"></span>` +
    `<input class="adm-input" data-sp-search placeholder="${t("plugin.sticky_posts.search")}" style="width:220px;"></div>` +
    `<div class="adm-card-bd"><div data-sp-catalogue></div>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-sp-more style="display:none;margin-top:10px;">${t("plugin.sticky_posts.more")}</button></div>` +
    `</div>` +
    `<template data-sp-tpl-pinned>${pinnedRowTpl(t)}</template>` +
    `<template data-sp-tpl-cat>${catalogueRowTpl(t)}</template>` +
    `</div>`
  );
}

const PANEL_SCRIPT_SRC = "/plugin-assets/sticky-posts/panel.js";

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    const own = readSettings(settings as Record<string, unknown>);
    addFilter<{ query: { context?: string } | unknown; ids: number[] }>(HOOKS.postsPinned, (payload) => {
      if (!own.ids.length) return payload;

      const q = (payload.query ?? {}) as { context?: string };
      if (own.includeHome === false && q.context === "home") return payload;
      // This plugin owns the canonical order; other contributors append after.
      const merged = [...own.ids];
      for (const id of payload.ids) {
        if (Number.isInteger(id) && id > 0 && !merged.includes(id)) merged.push(id);
      }
      return { ...payload, ids: merged };
    });

    addFilter<{ items: AdminMenuItem[] }>(HOOKS.adminMenu, (payload) => {
      payload.items.push({
        href: "/admin/plugins/sticky-posts",
        label: "@plugin.name.sticky_posts",
        glyph: "pin",
      });
      return payload;
    });

    addFilter<{ slug: string; html: string; scriptSrc: string; t: T }>(HOOKS.adminPanel, (payload) => {
      if (payload.slug !== "sticky-posts") return payload;
      payload.html = panelHtml(own, payload.t ?? makeT("zh-CN"));
      payload.scriptSrc = PANEL_SCRIPT_SRC;
      return payload;
    });
  },
});
