// Member-facing registration view. Rendered by the root catch-all when the
// admin-configured register path matches; every user-visible string goes
// through the translator so /en visitors never see Chinese chrome.
import { publicAssetHref } from "./theme-chrome.js";
import type { Locale, Translate } from "./i18n.js";

export type RegisterViewConfig = {
  nameRequired: boolean;
  passwordRequired: boolean;
  emailRequired: boolean;
  phoneRequired: boolean;
  emailVerify: boolean;
  phoneVerify: boolean;
  inviteOnly: boolean;
  captcha: { enabled: boolean; mode: "builtin" | "custom" | null };
};

export function registerView(config: RegisterViewConfig, t: Translate, locale: Locale) {
  const head =
    `<title>${t("reg.title")}</title>` +
    `<meta name="robots" content="noindex, nofollow">`;
  const field = (name: string, label: string, extra: string, required: boolean) =>
    `<div class="oboe-reg-fld">` +
    `<label>${label}${required ? "" : t("reg.optional")}</label>` +
    `<input class="oboe-reg-input" name="${name}" ${extra}${required ? " required" : ""}>` +
    `</div>`;
  const codeField = (name: string, sendAttr: string, label: string) =>
    `<div class="oboe-reg-fld">` +
    `<label>${label}</label>` +
    `<div class="oboe-reg-code">` +
    `<input class="oboe-reg-input" name="${name}" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="${t("reg.code_ph")}" required>` +
    `<button type="button" class="oboe-reg-send" ${sendAttr}>${t("reg.send_code")}</button>` +
    `</div></div>`;
  const captchaBlock = !config.captcha.enabled
    ? ""
    : config.captcha.mode === "custom"
      ? `<div class="oboe-reg-fld"><label>${t("reg.captcha")}</label>` +
        `<input class="oboe-reg-input" name="captchaToken" maxlength="200" autocomplete="off" placeholder="${t("reg.captcha_token_ph")}" required></div>`
      : `<div class="oboe-reg-fld"><label>${t("reg.captcha")}</label>` +
        `<div class="oboe-reg-code">` +
        `<input class="oboe-reg-input" name="captcha" maxlength="4" autocomplete="off" spellcheck="false" placeholder="${t("reg.captcha_ph")}" required style="max-width:120px;text-transform:uppercase;letter-spacing:.18em;">` +
        `<img data-oboe-reg-captcha-img src="/api/captcha/image" alt="${t("reg.captcha_alt")}" title="${t("reg.captcha_title")}" style="height:38px;width:120px;cursor:pointer;border:1px solid var(--border-color,#d4d4d8);border-radius:8px;background:#eef2f7;">` +
        `</div></div>`;
  const main =
    `<style>` +
    `.oboe-reg{display:flex;flex-direction:column;gap:16px}` +
    `.oboe-reg-fld{display:flex;flex-direction:column;gap:6px}` +
    `.oboe-reg-fld label{font-size:13px;color:var(--text-color-2,#52525b)}` +
    `.oboe-reg-input{width:100%;box-sizing:border-box;padding:9px 12px;font-size:14px;color:var(--text-color,#18181b);background:var(--background-2,#fff);border:1px solid var(--border-color,#d4d4d8);border-radius:8px;outline:none}` +
    `.oboe-reg-input:focus{border-color:var(--primary-color,#4f46e5)}` +
    `.oboe-reg-code{display:flex;align-items:center;gap:8px}` +
    `.oboe-reg-send{flex-shrink:0;white-space:nowrap;padding:9px 12px;font-size:12.5px;color:var(--primary-color,#4f46e5);background:transparent;border:1px solid var(--border-color,#d4d4d8);border-radius:8px;cursor:pointer}` +
    `.oboe-reg-send:disabled{opacity:.5;cursor:not-allowed}` +
    `.oboe-reg-msg{min-height:18px;margin:0;font-size:13px;color:#dc2626}` +
    `.oboe-reg-submit{padding:11px;font-size:14px;font-weight:600;color:#fff;background:var(--primary-color,#4f46e5);border:none;border-radius:8px;cursor:pointer}` +
    `.oboe-reg-submit:disabled{opacity:.6;cursor:not-allowed}` +
    `.oboe-reg-note{margin:0;text-align:center;font-size:12px;color:var(--text-color-3,#a1a1aa)}` +
    `</style>` +
    `<div class="container-np" style="padding:40px 16px 64px;max-width:520px;margin-inline:auto">` +
    `<h1 style="font-size:26px;font-weight:700;margin-bottom:20px;color:var(--text-color,var(--foreground,#18181b))">${t("reg.title")}</h1>` +
    `<form class="oboe-reg" data-oboe-reg` +
    ` data-oboe-reg-locale="${locale}"` +
    ` data-name-required="${config.nameRequired ? "1" : "0"}"` +
    ` data-password-required="${config.passwordRequired ? "1" : "0"}"` +
    ` data-email-required="${config.emailRequired ? "1" : "0"}"` +
    ` data-phone-required="${config.phoneRequired ? "1" : "0"}"` +
    ` data-invite-only="${config.inviteOnly ? "1" : "0"}">` +
    field("name", t("reg.name"), 'type="text" maxlength="32" autocomplete="username" placeholder="' + t("reg.name_ph") + '"', config.nameRequired) +
    field("email", t("reg.email"), 'type="email" maxlength="120" autocomplete="email"', config.emailRequired) +
    (config.emailVerify ? codeField("emailCode", 'data-oboe-reg-send="email"', t("reg.email_code")) : "") +
    field("phone", t("reg.phone"), 'type="tel" maxlength="20" autocomplete="tel" placeholder="' + t("reg.phone_ph") + '"', config.phoneRequired) +
    (config.phoneVerify ? codeField("phoneCode", 'data-oboe-reg-send="sms"', t("reg.phone_code")) : "") +
    (config.inviteOnly
      ? field("inviteCode", t("reg.invite"), 'type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="' + t("reg.invite_ph") + '"', true)
      : "") +
    field("password", t("reg.password"), `type="password" maxlength="200" autocomplete="new-password" placeholder="${config.passwordRequired ? t("reg.password_ph_req") : t("reg.password_ph_opt")}"`, config.passwordRequired) +
    captchaBlock +
    `<p class="oboe-reg-msg" data-oboe-reg-msg></p>` +
    `<button type="submit" class="oboe-reg-submit" data-oboe-reg-submit>${t("reg.submit")}</button>` +
    `<p class="oboe-reg-note">${t("reg.note")} · <a href="/" style="color:var(--primary-color,#4f46e5)">${t("reg.back_home")}</a></p>` +
    `</form>` +
    `</div>` +
    `<script src="${publicAssetHref("register.js")}" defer></script>`;
  return { head, main };
}
