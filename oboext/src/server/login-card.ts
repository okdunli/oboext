// The admin login card, rendered in two places with two different audiences:
// the /admin/login panel page (Chinese-only admin surface, admin.js binding)
// and the secret-entry wall on the public site (visitor-facing, this file's
// translator + the self-contained login-card.js binding). The translator
// defaults to Chinese so the admin call site stays byte-identical.
import { publicAssetHref } from "./theme-chrome.js";
import type { Locale, Translate } from "./i18n.js";
import { makeT, DEFAULT_LOCALE } from "./i18n.js";

type Captcha = { enabled: boolean; mode: "builtin" | "custom" | null };

export function loginCardHtml(
  captcha?: Captcha,
  t: Translate = makeT(DEFAULT_LOCALE),
  locale: Locale = DEFAULT_LOCALE
): string {
  const showCaptcha = !!captcha && captcha.enabled;
  return (
    `<div class="adm-auth-card" data-login-root data-oboe-login-locale="${locale}">` +
    `<h2 data-login-title>${t("login.title")}</h2>` +
    `<p class="adm-auth-sub" data-login-sub>${t("login.sub")}</p>` +
    `<form data-adm-form="login" data-login-mode="login">` +

    `<div class="adm-field" data-login-show="login forgot codelogin">` +
    `<label>${t("login.account")}</label>` +
    `<input class="adm-input" name="account" autocomplete="username" required autofocus>` +
    `</div>` +

    `<div class="adm-field" data-login-show="login">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;">` +
    `<label>${t("login.password")}</label>` +
    `<button type="button" class="adm-auth-link" data-adm-act="login-forgot">${t("login.forgot_link")}</button>` +
    `</div>` +
    `<input class="adm-input" type="password" name="password" autocomplete="current-password" required>` +
    `</div>` +

    `<div class="adm-field" data-login-show="codelogin" hidden>` +
    `<label data-login-target-label>${t("login.target_email")}</label>` +
    `<input class="adm-input" name="target" type="email" autocomplete="email" placeholder="${t("login.target_ph_email")}">` +
    `</div>` +
    `<div class="adm-field" data-login-show="codelogin" hidden>` +
    `<label>${t("login.code_label")}</label>` +
    `<div style="display:flex;align-items:center;gap:8px;">` +
    `<input class="adm-input" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="${t("login.code_ph")}" style="flex:1;">` +
    `<button type="button" class="adm-btn adm-btn-ghost" data-adm-act="login-send-code" style="flex-shrink:0;white-space:nowrap;">${t("login.send_code")}</button>` +
    `</div>` +
    `</div>` +

    `<div class="adm-field" data-login-show="forgot" hidden>` +
    `<label>${t("login.reset_code")}</label>` +
    `<input class="adm-input" name="resetCode" inputmode="numeric" maxlength="8" placeholder="${t("login.reset_code_ph")}">` +
    `</div>` +
    `<div class="adm-field" data-login-show="forgot" hidden>` +
    `<label>${t("login.new_password")}</label>` +
    `<input class="adm-input" type="password" name="resetPassword" minlength="8" autocomplete="new-password" placeholder="${t("login.new_password_ph")}">` +
    `</div>` +

    `<div class="adm-field" data-login-show="twofa" hidden>` +
    `<label>${t("login.twofa_label")}</label>` +
    `<input class="adm-input" name="twoFaCode" autocomplete="one-time-code" placeholder="${t("login.twofa_ph")}" autofocus>` +
    `<p class="adm-hint" style="margin:6px 0 0;">${t("login.twofa_hint")}</p>` +
    `</div>` +

    (showCaptcha
      ? `<div class="adm-field" data-login-captcha data-login-show="login codelogin forgot" hidden>` +
        `<label>${t("login.captcha")}</label>` +
        `<div style="display:flex;align-items:center;gap:8px;">` +
        `<input class="adm-input" name="captcha" maxlength="4" autocomplete="off" spellcheck="false" placeholder="${t("login.captcha_ph")}" style="width:120px;text-transform:uppercase;letter-spacing:.18em;" data-login-captcha-builtin>` +
        `<img data-login-captcha-img src="/api/captcha/image" alt="${t("login.captcha_alt")}" title="${t("login.captcha_title")}" style="height:38px;width:120px;cursor:pointer;border:1px solid var(--adm-border);border-radius:6px;background:#eef2f7;">` +
        `<input class="adm-input" name="captchaToken" maxlength="200" autocomplete="off" placeholder="${t("login.captcha_token_ph")}" data-login-captcha-custom hidden>` +
        `</div>` +
        `</div>`
      : "") +
    `<button class="adm-btn adm-btn-block" type="submit" data-login-submit>${t("login.submit")}</button>` +
    `<p class="adm-auth-msg" data-adm-msg></p>` +
    `</form>` +
    `<div data-login-links>` +
    `<button type="button" class="adm-auth-link" data-adm-act="login-codelogin" data-login-show="login" hidden>${t("login.codelogin_link")}</button>` +
    `<button type="button" class="adm-auth-link" data-adm-act="login-back" data-login-show="codelogin forgot" hidden>${t("login.back_link")}</button>` +
    `<button type="button" class="adm-auth-link" data-adm-act="login-2fa-back" data-login-show="twofa" hidden>${t("login.back_2fa_link")}</button>` +
    `</div>` +

    `<div data-login-oauth data-login-show="login codelogin" hidden></div>` +
    `<p class="adm-hint" style="margin-top:14px;text-align:center;">` +
    `${t("login.footer_hint")} · <a class="adm-auth-link" href="/">${t("login.back_home")}</a>` +
    `</p>` +
    `</div>`
  );
}

export function secretEntryPageHtml(captcha: Captcha | undefined, t: Translate, locale: Locale): string {
  return (
    `<div class="adm-auth">` +
    `<div class="adm-auth-main" style="min-height:100vh;">` +
    loginCardHtml(captcha, t, locale) +
    `</div>` +
    `</div>` +
    `<link rel="stylesheet" href="/public/admin.css">` +
    `<script src="${publicAssetHref("login-card.js")}" defer></script>`
  );
}
