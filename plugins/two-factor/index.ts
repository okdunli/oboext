import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import type { AdminMenuItem } from "../../oboext/src/server/admin-menu.js";
import type { SessionUser } from "../../oboext/src/server/auth.js";
import { getTwoFaState, verifyTwoFaCode } from "../../oboext/src/server/twofa.js";
import { makeT } from "../../oboext/src/server/i18n.js";

const PANEL_SCRIPT_SRC = "/plugin-assets/two-factor/panel.js";

function ic(n: string): string {
  return '<span class="adm-ic adm-ic-sm" style="--i:url(/public/icons/' + n + '.svg)"></span>';
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Escape a JSON payload for a double-quoted HTML attribute. */
function escAttr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function panelHtml(t: T): string {
  const dict = JSON.stringify({
    op_failed: t("plugin.two_factor.op_failed"),
    st_on: t("plugin.two_factor.st_on"),
    st_pending: t("plugin.two_factor.st_pending"),
    st_off: t("plugin.two_factor.st_off"),
    st_unavailable: t("plugin.two_factor.st_unavailable"),
    need_code: t("plugin.two_factor.need_code"),
    need_pw: t("plugin.two_factor.need_pw"),
    copied: t("plugin.two_factor.copied"),
    copy_fail: t("plugin.two_factor.copy_fail"),
    copy_unsupported: t("plugin.two_factor.copy_unsupported"),
    file_header: t("plugin.two_factor.file_header"),
  });
  return (
    `<div data-tf-panel data-i18n="${escAttr(dict)}">` +
    `<div class="adm-card" style="margin-bottom:16px;">` +
    `<div class="adm-card-hd"><strong style="font-size:15px;">${t("plugin.two_factor.title")}</strong>` +
    `<span class="spacer" style="flex:1"></span>` +
    `<span class="adm-hint" style="margin:0;" data-tf-state>${t("plugin.two_factor.loading")}</span></div>` +
    `<div class="adm-card-bd">` +
    `<p class="adm-hint" style="margin:0 0 12px;">${t("plugin.two_factor.hint")}</p>` +
    `<p class="adm-hint" style="margin:0 0 12px;color:#f87171;" data-tf-error hidden></p>` +

    `<div data-tf-step="idle" hidden>` +
    `<p class="adm-hint" style="margin:0 0 10px;color:#fbbf24;" data-tf-pending hidden>${t("plugin.two_factor.pending_hint")}</p>` +
    `<button type="button" class="adm-btn" data-tf-act="begin">${ic("key-round")}${t("plugin.two_factor.begin")}</button>` +
    `</div>` +

    `<div data-tf-step="enroll" hidden>` +
    `<p style="margin:0 0 8px;font-size:13px;">${t("plugin.two_factor.step1")}<a data-tf-otpauth href="#" style="color:var(--primary-color,#818cf8);">${t("plugin.two_factor.otpauth_link")}</a>${t("plugin.two_factor.step1_tail")}</p>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">` +
    `<code data-tf-secret style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;letter-spacing:.12em;color:#4ade80;background:var(--adm-panel-2);border:1px solid var(--adm-border);border-radius:8px;padding:8px 10px;"></code>` +
    `<button type="button" class="adm-iconbtn" data-tf-act="copy-secret" title="${t("plugin.two_factor.copy_secret")}">${ic("copy")}</button>` +
    `</div>` +
    `<p style="margin:0 0 8px;font-size:13px;">${t("plugin.two_factor.step2")}</p>` +
    `<div style="display:flex;align-items:center;gap:8px;">` +
    `<input class="adm-input" data-tf-confirm inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="max-width:180px;text-align:center;letter-spacing:.4em;">` +
    `<button type="button" class="adm-btn" data-tf-act="confirm">${t("plugin.two_factor.confirm")}</button>` +
    `<button type="button" class="adm-btn adm-btn-ghost" data-tf-act="cancel-enroll">${t("plugin.two_factor.cancel")}</button>` +
    `</div>` +
    `</div>` +

    `<div data-tf-step="on" hidden>` +
    `<p class="adm-hint" style="margin:0 0 12px;">${t("plugin.two_factor.remaining_pre")} <b data-tf-remaining style="color:var(--adm-text);">0</b> ${t("plugin.two_factor.remaining_post")}</p>` +
    `<div style="display:flex;flex-wrap:wrap;gap:8px;">` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-tf-act="open-regen">${ic("refresh-cw")}${t("plugin.two_factor.regen_open")}</button>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-tf-act="open-disable" style="color:#f87171;">${ic("shield-off")}${t("plugin.two_factor.disable_open")}</button>` +
    `</div>` +

    `<div data-tf-regen hidden style="margin-top:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">` +
    `<span class="adm-hint" style="margin:0;">${t("plugin.two_factor.regen_hint")}</span>` +
    `<input class="adm-input" data-tf-regen-code inputmode="numeric" maxlength="6" placeholder="123456" style="max-width:180px;text-align:center;letter-spacing:.4em;">` +
    `<button type="button" class="adm-btn adm-btn-sm" data-tf-act="regen">${t("plugin.two_factor.regen")}</button>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-tf-act="cancel-regen">${t("plugin.two_factor.cancel")}</button>` +
    `</div>` +

    `<div data-tf-disable hidden style="margin-top:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">` +
    `<span class="adm-hint" style="margin:0;">${t("plugin.two_factor.disable_hint")}</span>` +
    `<input class="adm-input" data-tf-disable-pw type="password" autocomplete="current-password" placeholder="${t("plugin.two_factor.pw_ph")}" style="max-width:220px;">` +
    `<button type="button" class="adm-btn adm-btn-sm" data-tf-act="disable" style="background:#dc2626;">${t("plugin.two_factor.disable")}</button>` +
    `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-tf-act="cancel-disable">${t("plugin.two_factor.cancel")}</button>` +
    `</div>` +
    `</div>` +
    `</div></div>` +

    `<div class="adm-card" data-tf-codes hidden>` +
    `<div class="adm-card-hd"><strong style="font-size:15px;">${t("plugin.two_factor.codes_pre")}<span data-tf-codes-n>0</span>${t("plugin.two_factor.codes_post")}</strong>` +
    `<span class="spacer" style="flex:1"></span>` +
    `<button type="button" class="adm-iconbtn" data-tf-act="copy-codes">${ic("copy")}${t("plugin.two_factor.copy")}</button>` +
    `<button type="button" class="adm-iconbtn" data-tf-act="download-codes">${ic("download")}${t("plugin.two_factor.download")}</button></div>` +
    `<div class="adm-card-bd">` +
    `<p class="adm-hint" style="margin:0 0 12px;color:#fbbf24;">${t("plugin.two_factor.codes_warn")}</p>` +
    `<div data-tf-codes-grid style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;"></div>` +
    `</div></div>` +
    `</div>`
  );
}

export default definePlugin({
  setup({ addFilter, HOOKS }) {
    addFilter<{
      user: SessionUser;
      challenge: { type: string } | null;
    }>(HOOKS.authChallenge, async (payload) => {
      if (payload.challenge) return payload;
      const state = await getTwoFaState(payload.user.id);
      if (state?.enabled) return { ...payload, challenge: { type: "totp" } };
      return payload;
    });

    addFilter<{ user: SessionUser; code: string; ok: boolean }>(
      HOOKS.authChallengeVerify,
      async (payload) => {
        if (payload.ok) return payload;
        const passed = await verifyTwoFaCode(payload.user.id, payload.code);
        return passed ? { ...payload, ok: true } : payload;
      },
    );

    addFilter<{ items: AdminMenuItem[] }>(HOOKS.adminMenu, (payload) => {
      payload.items.push({
        href: "/admin/plugins/two-factor",
        label: "@plugin.name.two_factor",
        glyph: "shield-check",
      });
      return payload;
    });

    addFilter<{ slug: string; html: string; scriptSrc: string; t: T }>(HOOKS.adminPanel, (payload) => {
      if (payload.slug !== "two-factor") return payload;
      payload.html = panelHtml(payload.t ?? makeT("zh-CN"));
      payload.scriptSrc = PANEL_SCRIPT_SRC;
      return payload;
    });
  },
});
