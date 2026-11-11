// "Reset 2FA" in the user list: clears another account's second factor when
// the phone and the recovery codes are both gone. admin.js has no case for
// this action, so the handler lives here and delegates from the button.
(function () {
  "use strict";
  var TXT = {
    zh: {
      confirm: "确认清除用户「{name}」的两步验证？对方下次登录只需密码。",
      err: "操作失败，请重试",
    },
    en: {
      confirm: 'Clear the second factor for "{name}"? The next sign-in will only need the password.',
      err: "Reset failed, please retry",
    },
  };

  function T() {
    return (document.documentElement.lang || "").toLowerCase().indexOf("en") === 0 ? TXT.en : TXT.zh;
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest('[data-adm-act="user-twofa-reset"]') : null;
    if (!btn) return;
    var name = btn.getAttribute("data-name") || "";
    if (!window.confirm(T().confirm.replace("{name}", name))) return;
    btn.disabled = true;
    fetch(btn.getAttribute("data-url"), { method: "POST", credentials: "same-origin" })
      .then(function (res) {
        return res.json().then(function (j) {
          if (!res.ok) throw new Error(j.error || T().err);
          return j;
        });
      })
      .then(function () {
        var row = btn.closest("tr");
        var cell = row && row.querySelector("[data-twofa-cell]");
        if (cell) cell.textContent = "—";
        btn.remove();
      })
      .catch(function (err) {
        btn.disabled = false;
        window.alert(err.message || T().err);
      });
  });
})();
