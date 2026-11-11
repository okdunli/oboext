// Two-factor enrollment UI. The service (TOTP state, recovery codes, the
// login step-two flow) existed with endpoints but no surface anywhere, so no
// user could ever turn it on. This panel rides the account page's section
// rail; everything it does goes through /api/account/twofa.
(function () {
  "use strict";
  var TXT = {
    zh: {
      title: "两步验证",
      off: "未开启。开启后登录需要输入验证器 App 的 6 位动态码。",
      on: "已开启。登录时需输入动态码；换机请用恢复码。",
      begin: "开始绑定",
      confirm: "确认绑定",
      disable: "关闭两步验证",
      regen: "重新生成恢复码",
      codePh: "6 位动态码",
      pwPh: "登录密码",
      scan: "用验证器 App 扫描，或手动输入密钥：",
      recovery: "恢复码（仅显示一次，请妥善保存）：",
      saving: "处理中…",
      err: "操作失败，请重试",
    },
    en: {
      title: "Two-factor",
      off: "Off. Once on, sign-in asks for the 6-digit code from your authenticator app.",
      on: "On. Sign-in asks for a code; use a recovery code when switching devices.",
      begin: "Start pairing",
      confirm: "Confirm pairing",
      disable: "Turn off 2FA",
      regen: "Regenerate recovery codes",
      codePh: "6-digit code",
      pwPh: "Login password",
      scan: "Scan with your authenticator app, or enter the key:",
      recovery: "Recovery codes (shown once, store them safely):",
      saving: "Working…",
      err: "Operation failed, please retry",
    },
  };
  var state = { enabled: false, secret: "", otpauth: "" };

  function T() {
    return (document.documentElement.lang || "").toLowerCase().indexOf("en") === 0 ? TXT.en : TXT.zh;
  }

  function api(body) {
    return fetch("/api/account/twofa", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok) throw new Error(j.error || T().err);
        return j;
      });
    });
  }

  function esc(x) {
    return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function codesHtml(codes) {
    if (!codes || !codes.length) return "";
    return (
      '<p style="margin:8px 0 4px;font-weight:600">' + esc(T().recovery) + "</p>" +
      '<code style="display:block;white-space:pre-wrap;user-select:all">' + esc(codes.join("\n")) + "</code>"
    );
  }

  function render(host) {
    var t = T();
    var html = '<div class="adm-card"><div class="adm-card-hd"><strong style="font-size:14px;">' + esc(t.title) + "</strong></div><div class=\"adm-card-bd\" data-2fa-body>";
    html += '<p style="margin:0 0 10px;color:var(--adm-muted)">' + esc(state.enabled ? t.on : t.off) + "</p>";
    if (state.enabled) {
      html +=
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">' +
        '<input class="adm-input" data-2fa-code placeholder="' + esc(t.codePh) + '" inputmode="numeric" maxlength="6" style="max-width:140px">' +
        '<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-2fa-act="regen">' + esc(t.regen) + "</button>" +
        "</div>" +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<input class="adm-input" data-2fa-pw type="password" placeholder="' + esc(t.pwPh) + '" autocomplete="current-password" style="max-width:180px">' +
        '<button type="button" class="adm-btn adm-btn-danger adm-btn-sm" data-2fa-act="disable">' + esc(t.disable) + "</button>" +
        "</div>";
    } else {
      html += '<button type="button" class="adm-btn adm-btn-sm" data-2fa-act="begin">' + esc(t.begin) + "</button>";
    }
    html += '<div data-2fa-out style="margin-top:10px"></div></div></div>';
    host.innerHTML = html;
  }

  function busy(host, on) {
    var body = host.querySelector("[data-2fa-body]");
    if (body) body.style.opacity = on ? "0.5" : "";
  }

  function act(host, action, extra) {
    var out = host.querySelector("[data-2fa-out]");
    busy(host, true);
    api(Object.assign({ action: action }, extra || {}))
      .then(function (data) {
        if (action === "begin") {
          state.secret = data.secret;
          state.otpauth = data.otpauth;
          render(host);
          var o = host.querySelector("[data-2fa-out]");
          o.innerHTML =
            "<p style='margin:0 0 6px'>" + esc(T().scan) + "</p>" +
            "<code style='display:block;user-select:all;word-break:break-all'>" + esc(state.secret) + "</code>" +
            '<p style="margin:6px 0 0;color:var(--adm-muted);font-size:12px">' + esc(state.otpauth) + "</p>" +
            '<div style="display:flex;gap:8px;margin-top:10px;align-items:center">' +
            '<input class="adm-input" data-2fa-code placeholder="' + esc(T().codePh) + '" inputmode="numeric" maxlength="6" style="max-width:140px">' +
            '<button type="button" class="adm-btn adm-btn-sm" data-2fa-act="confirm">' + esc(T().confirm) + "</button>" +
            "</div>";
          return;
        }
        if (action === "confirm" || action === "regen") {
          state.enabled = true;
          render(host);
          host.querySelector("[data-2fa-out]").innerHTML = codesHtml(data.recoveryCodes);
          return;
        }
        if (action === "disable") {
          state.enabled = false;
          render(host);
        }
      })
      .catch(function (e) {
        if (out) out.innerHTML = '<p style="margin:0;color:#f87171">' + esc(e.message || T().err) + "</p>";
      })
      .then(function () {
        busy(host, false);
      });
  }

  function wire(host) {
    host.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-2fa-act]") : null;
      if (!btn) return;
      var act2 = btn.getAttribute("data-2fa-act");
      var code = host.querySelector("[data-2fa-code]");
      var pw = host.querySelector("[data-2fa-pw]");
      if (act2 === "begin") return act(host, "begin");
      if (act2 === "confirm") return act(host, "confirm", { code: code ? code.value.trim() : "" });
      if (act2 === "regen") return act(host, "regen", { code: code ? code.value.trim() : "" });
      if (act2 === "disable") return act(host, "disable", { password: pw ? pw.value : "" });
    });
  }

  function boot() {
    // The account page's rail builds sections statically; this panel is appended
    // as a fourth one when the rail exists.
    var body = document.querySelector("[data-acc-body]");
    var nav = document.querySelector("[data-acc-nav]");
    if (!body || body.querySelector("[data-2fa-panel]")) return;
    var host = document.createElement("section");
    host.setAttribute("data-acc-sec", "twofa");
    host.setAttribute("data-2fa-panel", "1");
    body.appendChild(host);
    wire(host);
    render(host);

    if (nav) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "adm-thp-navbtn";
      btn.setAttribute("data-sec", "twofa");
      btn.textContent = T().title;
      nav.appendChild(btn);
    }

    fetch("/api/account/twofa", { credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (data && typeof data.enabled === "boolean") {
          state.enabled = data.enabled;
          render(host);
        }
      })
      .catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  document.addEventListener("rv:nav", boot);
})();
