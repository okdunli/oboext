

export function loginCardHtml(): string {
  return (
    `<div class="adm-auth-card" data-login-root>` +
    `<h2 data-login-title>欢迎回来</h2>` +
    `<p class="adm-auth-sub" data-login-sub>登录以管理你的站点内容</p>` +
    `<form data-adm-form="login" data-login-mode="login">` +

    `<div class="adm-field" data-login-show="login forgot codelogin">` +
    `<label>邮箱或昵称</label>` +
    `<input class="adm-input" name="account" autocomplete="username" required autofocus>` +
    `</div>` +

    `<div class="adm-field" data-login-show="login">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;">` +
    `<label>密码</label>` +
    `<button type="button" class="adm-auth-link" data-adm-act="login-forgot">忘记密码？</button>` +
    `</div>` +
    `<input class="adm-input" type="password" name="password" autocomplete="current-password" required>` +
    `</div>` +

    `<div class="adm-field" data-login-show="codelogin" hidden>` +
    `<label data-login-target-label>登录邮箱</label>` +
    `<input class="adm-input" name="target" type="email" autocomplete="email" placeholder="账号绑定的邮箱">` +
    `</div>` +
    `<div class="adm-field" data-login-show="codelogin" hidden>` +
    `<label>登录验证码</label>` +
    `<div style="display:flex;align-items:center;gap:8px;">` +
    `<input class="adm-input" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" style="flex:1;">` +
    `<button type="button" class="adm-btn adm-btn-ghost" data-adm-act="login-send-code" style="flex-shrink:0;white-space:nowrap;">发送验证码</button>` +
    `</div>` +
    `</div>` +

    `<div class="adm-field" data-login-show="forgot" hidden>` +
    `<label>邮箱重置码</label>` +
    `<input class="adm-input" name="resetCode" inputmode="numeric" maxlength="8" placeholder="邮件中的 6 位验证码">` +
    `</div>` +
    `<div class="adm-field" data-login-show="forgot" hidden>` +
    `<label>新密码</label>` +
    `<input class="adm-input" type="password" name="resetPassword" minlength="8" autocomplete="new-password" placeholder="至少 8 位">` +
    `</div>` +

    `<div class="adm-field" data-login-show="twofa" hidden>` +
    `<label>动态码或恢复码</label>` +
    `<input class="adm-input" name="twoFaCode" autocomplete="one-time-code" placeholder="6 位动态码，或 XXXX-XXXX 恢复码" autofocus>` +
    `<p class="adm-hint" style="margin:6px 0 0;">打开验证器 App 获取当前 6 位动态码；手机不可用时可输入任一未使用的恢复码。</p>` +
    `</div>` +

    `<div class="adm-field" data-login-captcha data-login-show="login codelogin forgot" hidden>` +
    `<label>验证码</label>` +
    `<div style="display:flex;align-items:center;gap:8px;">` +
    `<input class="adm-input" name="captcha" maxlength="4" autocomplete="off" spellcheck="false" placeholder="4 位字符" style="width:120px;text-transform:uppercase;letter-spacing:.18em;" data-login-captcha-builtin>` +
    `<img data-login-captcha-img src="/api/captcha/image" alt="验证码" title="看不清？点击刷新" style="height:38px;width:120px;cursor:pointer;border:1px solid var(--adm-border);border-radius:6px;background:#eef2f7;">` +
    `<input class="adm-input" name="captchaToken" maxlength="200" autocomplete="off" placeholder="第三方验证码凭证" data-login-captcha-custom hidden>` +
    `</div>` +
    `</div>` +
    `<button class="adm-btn adm-btn-block" type="submit" data-login-submit>登 录</button>` +
    `<p class="adm-auth-msg" data-adm-msg></p>` +
    `</form>` +
    `<div data-login-links>` +
    `<button type="button" class="adm-auth-link" data-adm-act="login-codelogin" data-login-show="login" hidden>使用邮箱/手机验证码登录</button>` +
    `<button type="button" class="adm-auth-link" data-adm-act="login-back" data-login-show="codelogin forgot" hidden>返回账号密码登录</button>` +
    `<button type="button" class="adm-auth-link" data-adm-act="login-2fa-back" data-login-show="twofa" hidden>返回账号密码步骤</button>` +
    `</div>` +

    `<div data-login-oauth data-login-show="login codelogin" hidden></div>` +
    `<p class="adm-hint" style="margin-top:14px;text-align:center;">` +
    `可用邮箱或昵称登录 · <a class="adm-auth-link" href="/">返回站点首页</a>` +
    `</p>` +
    `</div>`
  );
}

export function secretEntryPageHtml(): string {
  return (
    `<div class="adm-auth">` +
    `<div class="adm-auth-main" style="min-height:100vh;">` +
    loginCardHtml() +
    `</div>` +
    `</div>` +
    `<link rel="stylesheet" href="/public/admin.css">` +
    `<script src="/public/admin.js"></script>`
  );
}
