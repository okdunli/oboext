import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import { HOOKS } from "../../oboext/src/server/hooks.js";
import type { AdminMenuItem } from "../../oboext/src/server/admin-menu.js";
import { makeT, type Locale } from "../../oboext/src/server/i18n.js";

/**
 * comment-emoji — take over the theme's comment emoji panel.
 *
 * Data model (one settings blob, machine-managed by the admin panel):
 *   groups: [{ name, icon, items: [{ type: "text"|"image", value, title? }] }]
 *
 * "text" covers emoji / kaomoji / quick phrases (inserted verbatim);
 * "image" covers local, media-library or arbitrary URLs (static or GIF).
 *
 * The front desk does not change the theme: the theme still opens its own
 * `[data-emoji-panel]`, we simply swap the `.emoji-panel` it builds for ours,
 * so all existing positioning CSS keeps working. Comment bodies are plain
 * escaped text; image emoji are upgraded to <img> by the same script.
 */

export type EmojiItem =
  | { type: "text"; value: string; title?: string }
  | { type: "image"; url: string; title?: string };

export type EmojiGroup = { name: string; icon: string; items: EmojiItem[] };

export type Settings = {
  enabled: boolean;
  groups: EmojiGroup[];
  panelW: number;
  panelH: number;
  itemW: number;
  itemH: number;
  showTitle: boolean;
};

const ICON_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function clampInt(raw: unknown, dflt: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Tolerant read: a hand-edited or legacy settings blob must never throw. */
function readSettings(raw: Record<string, unknown>): Settings {
  const groups: EmojiGroup[] = [];
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups as unknown[]) {
      if (!g || typeof g !== "object") continue;
      const gg = g as Record<string, unknown>;
      const items: EmojiItem[] = [];
      if (Array.isArray(gg.items)) {
        for (const it of gg.items as unknown[]) {
          if (!it || typeof it !== "object") continue;
          const ii = it as Record<string, unknown>;
          const title = typeof ii.title === "string" ? ii.title.slice(0, 60) : undefined;
          if (ii.type === "image" && typeof ii.url === "string" && ii.url.trim()) {
            items.push({ type: "image", url: ii.url.trim().slice(0, 2048), title });
          } else if (typeof ii.value === "string" && ii.value) {
            items.push({ type: "text", value: ii.value.slice(0, 2000), title });
          }
        }
      }
      groups.push({
        // Empty when unset: the client renders the localized "unnamed" label,
        // so a stored group name never freezes one language into the data.
        name: String(gg.name ?? "").slice(0, 40),
        icon: typeof gg.icon === "string" ? gg.icon.slice(0, 24) : "smile",
        items,
      });
    }
  }
  return {
    enabled: raw.enabled !== false,
    groups,
    // 0 means "unbounded" for the panel dimensions.
    panelW: clampInt(raw.panelW, 320, 0, 800),
    panelH: clampInt(raw.panelH, 260, 0, 800),
    itemW: clampInt(raw.itemW, 64, 16, 400),
    itemH: clampInt(raw.itemH, 64, 16, 400),
    showTitle: raw.showTitle !== false,
  };
}

/** JSON for the front desk — embedded inline so the panel needs no extra request. */
function clientPayload(s: Settings): string {
  return JSON.stringify({
    groups: s.groups,
    panelW: s.panelW,
    panelH: s.panelH,
    itemW: s.itemW,
    itemH: s.itemH,
    showTitle: s.showTitle,
  });
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ic(n: string): string {
  return '<span class="adm-ic adm-ic-sm" style="--i:url(/public/icons/' + n + '.svg)"></span>';
}

/** A safe-to-inline copy: `</script>` inside a JSON string would end the tag. */
function safeInlineJson(json: string): string {
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

// ------------------------------------------------------------ admin panel

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Escape a JSON payload for a double-quoted HTML attribute. */
function escAttr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function groupRowTpl(t: T): string {
  return (
    `<div class="adm-card" style="margin-bottom:10px;padding:12px;" data-ce-group>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">` +
    `<input class="adm-input adm-group-icon" data-ce-g-icon data-icon-picker="compact" placeholder="${t("plugin.comment_emoji.icon_ph")}" value="" style="width:52px;flex:0 0 auto;">` +
    `<input class="adm-input" data-ce-g-name placeholder="${t("plugin.comment_emoji.name_ph")}" style="flex:1;min-width:0;">` +
    `<button type="button" class="adm-iconbtn" data-ce-g-up title="${t("plugin.comment_emoji.move_up")}">${ic("arrow-up")}</button>` +
    `<button type="button" class="adm-iconbtn" data-ce-g-down title="${t("plugin.comment_emoji.move_down")}">${ic("arrow-down")}</button>` +
    `<button type="button" class="adm-iconbtn danger" data-ce-g-del title="${t("plugin.comment_emoji.remove_group")}">${ic("trash-2")}</button>` +
    `</div>` +
    `<div data-ce-items></div>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-ce-item-add style="margin-top:8px;">${ic("plus")}${t("plugin.comment_emoji.add_item")}</button>` +
    `</div>`
  );
}

function itemRowTpl(t: T): string {
  return (
    `<div style="display:flex;align-items:flex-start;gap:6px;padding:8px 0;border-top:1px solid var(--adm-border);" data-ce-item>` +
    `<select class="adm-input" data-ce-i-type style="width:104px;flex:0 0 auto;">` +
    `<option value="text">${t("plugin.comment_emoji.type_text")}</option>` +
    `<option value="image">${t("plugin.comment_emoji.type_image")}</option>` +
    `</select>` +
    `<div style="flex:1;min-width:0;">` +
    `<textarea class="adm-input" data-ce-i-value rows="2" placeholder="${t("plugin.comment_emoji.value_ph")}" style="width:100%;resize:vertical;font-family:inherit;"></textarea>` +
    `<div data-ce-i-image style="display:none;gap:6px;">` +
    `<input class="adm-input" data-ce-i-url placeholder="${t("plugin.comment_emoji.url_ph")}" style="flex:1;min-width:0;">` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-ce-i-media title="${t("plugin.comment_emoji.pick_media")}" style="flex:0 0 auto;">${ic("image")}${t("plugin.comment_emoji.media_btn")}</button>` +
    `</div>` +
    `<input class="adm-input" data-ce-i-title placeholder="${t("plugin.comment_emoji.title_ph")}" style="margin-top:6px;width:100%;">` +
    `</div>` +
    `<div style="display:flex;flex-direction:column;gap:4px;flex:0 0 auto;">` +
    `<button type="button" class="adm-iconbtn" data-ce-i-up title="${t("plugin.comment_emoji.move_up")}">${ic("arrow-up")}</button>` +
    `<button type="button" class="adm-iconbtn" data-ce-i-down title="${t("plugin.comment_emoji.move_down")}">${ic("arrow-down")}</button>` +
    `<button type="button" class="adm-iconbtn danger" data-ce-i-del title="${t("plugin.comment_emoji.remove")}">${ic("trash-2")}</button>` +
    `</div>` +
    `</div>`
  );
}

function panelHtml(s: Settings, t: T): string {
  const dict = JSON.stringify({
    empty_groups: t("plugin.comment_emoji.empty_groups"),
    empty_items: t("plugin.comment_emoji.empty_items"),
    unnamed: t("plugin.comment_emoji.unnamed"),
    saving: t("plugin.comment_emoji.saving"),
    saved_n: t("plugin.comment_emoji.saved_n"),
    save_failed: t("plugin.comment_emoji.save_failed"),
    exported: t("plugin.comment_emoji.exported"),
    import_prompt: t("plugin.comment_emoji.import_prompt"),
    import_bad_json: t("plugin.comment_emoji.import_bad_json"),
    import_bad_shape: t("plugin.comment_emoji.import_bad_shape"),
    media_title: t("plugin.comment_emoji.media_title"),
    close: t("plugin.comment_emoji.close"),
    loading: t("plugin.comment_emoji.loading"),
    media_empty: t("plugin.comment_emoji.media_empty"),
    media_failed: t("plugin.comment_emoji.media_failed"),
    new_group: t("plugin.comment_emoji.new_group"),
    confirm_del_group: t("plugin.comment_emoji.confirm_del_group"),
    state_empty: t("plugin.comment_emoji.state_empty"),
    state_n: t("plugin.comment_emoji.state_n"),
  });
  return (
    `<div data-ce-panel data-i18n="${escAttr(dict)}">` +
    `<div class="adm-card" style="margin-bottom:16px;">` +
    `<div class="adm-card-hd"><strong style="font-size:15px;">${t("plugin.comment_emoji.title")}</strong>` +
    `<span style="flex:1"></span>` +
    `<span class="adm-hint" style="margin:0;" data-ce-state></span></div>` +
    `<div class="adm-card-bd">` +
    `<p class="adm-hint" style="margin:0 0 12px;">${t("plugin.comment_emoji.hint")}</p>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-ce-add-group>${ic("folder-plus")}${t("plugin.comment_emoji.add_group")}</button>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-ce-export>${ic("download")}${t("plugin.comment_emoji.export")}</button>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-ce-import>${ic("upload")}${t("plugin.comment_emoji.import")}</button>` +
    `</div>` +
    `<div data-ce-groups></div>` +
    `</div></div>` +
    `<template data-ce-tpl-group>${groupRowTpl(t)}</template>` +
    `<template data-ce-tpl-item>${itemRowTpl(t)}</template>` +
    `</div>`
  );
}

const PANEL_SCRIPT_SRC = "/plugin-assets/comment-emoji/panel.js";

// ------------------------------------------------------------------ client

function clientScript(s: Settings, locale: Locale): string {
  const cfg = safeInlineJson(clientPayload(s));
  const t = makeT(locale);
  const emptyCopy = t("plugin.comment_emoji.empty_groups");
  const unnamed = t("plugin.comment_emoji.unnamed");
  return `(function(){
var C=${cfg};
var EMPTY=${JSON.stringify(emptyCopy)};
var UNNAMED=${JSON.stringify(unnamed)};
var IMG_RE=/(?:https?:)?\\/\\/[^\\s<>"']+\\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:\\?[^\\s<>"']*)?/gi;
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function styleStr(){return "max-width:"+(C.itemW||64)+"px;max-height:"+(C.itemH||64)+"px;";}
var ICON_RE_X=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function groupIcon(g){
  var n=g.icon||"smile";
  if(ICON_RE_X.test(n))return '<span class="adm-ic" style="--i:url(/public/icons/'+esc(n)+'.svg);width:18px;height:18px;display:inline-block"></span>';
  return '<span style="font-size:15px;line-height:18px;display:inline-block;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(g.name||UNNAMED)+'">'+esc(n)+'</span>';
}
/* ---------------------------------------------------- panel construction */
function buildPanel(){
  var wrap=document.createElement("span");
  wrap.className="emoji-panel";
  wrap.onmousedown=function(e){e.preventDefault();};
  var groups=C.groups||[];
  if(!groups.length){
    wrap.innerHTML='<div class="panel"><p class="ce-empty" style="padding:28px 12px;text-align:center;opacity:.6;font-size:13px;">'+EMPTY+'</p></div>';
    return wrap;
  }
  var inner='<div class="panel" style="'+(C.panelH?("max-height:"+C.panelH+"px;"):"")+'">';
  groups.forEach(function(g){
    var items=(g.items||[]);
    if(!items.length)return;
    inner+='<section class="emoji-group" data-ce-group="'+esc(g.name)+'">';
    inner+='<div class="title" style="display:flex;align-items:center;gap:6px;">'+groupIcon(g)+"<span>"+esc(g.name||UNNAMED)+"</span></div>";
    inner+='<div class="emoji-grid ce-grid" style="'+(C.panelW?("max-width:"+C.panelW+"px;"):"")+'">';
    items.forEach(function(it,i){
      var t=it.title?' title="'+esc(it.title)+'"':"";
      if(it.type==="image"){
        inner+='<button type="button" class="emoji ce-img" data-ce-pick="'+esc(it.url)+'"'+t+' style="'+(C.itemW?("width:"+C.itemW+"px;"):"")+'">'+
          '<img src="'+esc(it.url)+'" alt="'+esc(it.title||"")+'" loading="lazy" style="'+styleStr()+'">'+
          (C.showTitle&&it.title?'<b style="display:block;font-size:11px;font-weight:400;opacity:.7;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(it.title)+"</b>":"")+
          "</button>";
      }else{
        inner+='<button type="button" class="emoji" data-ce-pick="'+esc(it.value)+'"'+t+' style="min-width:34px;font-size:17px;line-height:1.4;">'+
          esc(it.value)+(C.showTitle&&it.title?'<b style="display:block;font-size:11px;font-weight:400;opacity:.7;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(it.title)+"</b>":"")+
          "</button>";
      }
    });
    inner+="</div></section>";
  });
  inner+="</div>";
  var tabs=groups.filter(function(g){return (g.items||[]).length;});
  if(tabs.length){
    inner+='<div class="tabs">'+tabs.map(function(g,i){
      return '<button type="button" class="emoji-tab'+(i===0?" active":"")+'" title="'+esc(g.name)+'" data-ce-tab="'+i+'">'+groupIcon(g)+"</button>";
    }).join("")+"</div>";
  }
  wrap.innerHTML=inner;
  return wrap;
}
function findPanel(){
  var open=document.querySelector("[data-emoji-panel].is-in");
  return open||null;
}
/* The theme builds its own .emoji-panel from /api/emojis; we swap in ours so
   every positioning rule the theme already ships keeps applying. */
function takeOver(){
  if(takeOver.__done)return;
  var host=findPanel();
  if(!host)return;
  var themePanel=host.querySelector(".emoji-panel");
  if(!themePanel)return;
  takeOver.__done=true;
  var ours=buildPanel();
  host.replaceChild(ours,themePanel);
  ours.querySelectorAll("[data-ce-tab]").forEach(function(b){
    b.addEventListener("click",function(){
      var tab=(C.groups||[]).filter(function(g){return (g.items||[]).length;})[Number(b.getAttribute("data-ce-tab"))];
      if(!tab)return;
      var sec=ours.querySelector('.emoji-group[data-ce-group="'+tab.name.replace(/"/g,'\\\\"')+'"]');
      var panel=ours.querySelector(".panel");
      if(sec&&panel)panel.scrollTop=sec.offsetTop;
    });
  });
  host.addEventListener("click",function(e){
    var b=e.target.closest&&e.target.closest("[data-ce-pick]");
    if(!b||!host.contains(b))return;
    var form=host.closest("form");
    if(form)insert(form,b.getAttribute("data-ce-pick"));
  });
}
function insert(form,text){
  var ta=form.querySelector('textarea[name="content"]');
  if(!ta)return;
  var start=ta.selectionStart!=null?ta.selectionStart:ta.value.length;
  var end=ta.selectionEnd!=null?ta.selectionEnd:ta.value.length;
  ta.value=ta.value.slice(0,start)+text+ta.value.slice(end);
  ta.focus();
  ta.setSelectionRange(start+text.length,start+text.length);
  ta.dispatchEvent(new Event("input",{bubbles:true}));
}
/* ------------------------------------------------- comment list rendering */
function upgrade(root){
  var nodes=(root||document).querySelectorAll(".content.has-emoji");
  nodes.forEach(function(el){
    if(el.getAttribute("data-ce-done")==="1")return;
    var txt=el.textContent||"";
    if(!IMG_RE.test(txt)){el.setAttribute("data-ce-done","1");return;}
    IMG_RE.lastIndex=0;
    var html="",last=0,m;
    while((m=IMG_RE.exec(txt))){
      html+=esc(txt.slice(last,m.index));
      html+='<img src="'+esc(m[0])+'" alt="" loading="lazy" class="ce-comment-img" style="'+styleStr()+'vertical-align:middle;">';
      last=m.index+m[0].length;
    }
    html+=esc(txt.slice(last));
    el.innerHTML=html;
    el.setAttribute("data-ce-done","1");
  });
}
/* -------------------------------------------------------------- lifecycle */
function boot(){
  takeOver();
  upgrade(document);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
var mo=new MutationObserver(function(){
  var host=findPanel();
  if(host&&!takeOver.__done)takeOver();
  upgrade(document);
});
mo.observe(document.documentElement,{childList:true,subtree:true});
})();`;
}

// ------------------------------------------------------------------- setup

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    const own = readSettings(settings as Record<string, unknown>);

    addFilter<{ items: AdminMenuItem[] }>(HOOKS.adminMenu, (payload) => {
      payload.items.push({
        href: "/admin/plugins/comment-emoji",
        label: "@plugin.name.comment_emoji",
        glyph: "smile-plus",
      });
      return payload;
    });

    addFilter<{ slug: string; html: string; scriptSrc: string; t: T }>(HOOKS.adminPanel, (payload) => {
      if (payload.slug !== "comment-emoji") return payload;
      payload.html = panelHtml(own, payload.t ?? makeT("zh-CN"));
      payload.scriptSrc = PANEL_SCRIPT_SRC;
      return payload;
    });

    addFilter<{ html: string[]; locale: Locale }>(HOOKS.footerHtml, (payload) => {
      // Off by default when disabled: leave the theme's own panel untouched.
      if (!own.enabled) return payload;
      payload.html.push(`<script>${clientScript(own, payload.locale ?? "zh-CN")}</script>`);
      return payload;
    });
  },
});
