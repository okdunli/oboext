// A third-party login cannot ask for the second factor on its own callback
// page, so the callback bounces here with ?twofa=1&ticket=… and no session.
// Take over the login card and redeem the ticket through the same API step the
// password flow uses.
(function () {
  var params = new URLSearchParams(location.search);
  var ticket = params.get("ticket");
  var root = document.querySelector("[data-login-root]");
  if (!ticket || params.get("twofa") !== "1" || !root) return;

  // Keep the ticket out of history and out of any outbound referer.
  history.replaceState(null, "", location.pathname);

  var locale = root.getAttribute("data-oboe-login-locale") || "zh-CN";
  var copy =
    locale.indexOf("en") === 0
      ? {
          title: "Two-step verification",
          sub: "Enter your authenticator or recovery code to finish signing in",
          label: "Authenticator code",
          submit: "Verify and sign in",
          wrong: "That code did not work, please try again",
          failed: "Verification failed, please try again",
        }
      : {
          title: "两步验证",
          sub: "输入动态码或恢复码完成登录",
          label: "动态码",
          submit: "验证并登录",
          wrong: "验证码不正确，请重试",
          failed: "验证失败，请重试",
        };

  var old = root.querySelector('form[data-adm-form="login"]');
  if (old) old.hidden = true;
  root
    .querySelectorAll("[data-login-title],[data-login-sub],[data-login-links],[data-login-oauth]")
    .forEach(function (el) {
      el.hidden = true;
    });

  var form = document.createElement("form");
  form.innerHTML =
    "<h2>" + copy.title + "</h2>" +
    '<p class="adm-auth-sub">' + copy.sub + "</p>" +
    '<div class="adm-field"><label>' + copy.label + "</label>" +
    '<input class="adm-input" name="code" aria-label="' + copy.label + '" inputmode="numeric" autocomplete="one-time-code" required autofocus></div>' +
    '<button class="adm-btn adm-btn-block" type="submit">' + copy.submit + "</button>" +
    '<p class="adm-auth-msg" data-twofa-msg></p>';
  root.insertBefore(form, old ? old.nextSibling : root.firstChild);

  var note = form.querySelector("[data-twofa-msg]");
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    var button = form.querySelector("button");
    button.disabled = true;
    note.textContent = "";
    try {
      var res = await fetch("/api/auth/login-2fa", {
        method: "POST",
        headers: { "content-type": "application/json", "x-locale": locale },
        body: JSON.stringify({
          ticket: ticket,
          code: form.elements.code.value.replace(/\s/g, ""),
        }),
      });
      if (res.ok) {
        location.href = "/admin";
        return;
      }
      var data = await res.json().catch(function () {
        return {};
      });
      note.textContent = data.error || copy.wrong;
    } catch (err) {
      note.textContent = copy.failed;
    }
    button.disabled = false;
  });
})();
