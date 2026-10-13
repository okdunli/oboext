

(function () {
  "use strict";
  var form = document.querySelector("form[data-oboe-reg]");
  if (!form) return;
  var msg = form.querySelector("[data-oboe-reg-msg]");
  var submitBtn = form.querySelector("[data-oboe-reg-submit]");
  var flag = function (name) {
    return form.getAttribute(name) === "1";
  };
  var timers = [];

  function say(text, ok) {
    if (!msg) return;
    msg.textContent = text || "";
    msg.style.color = ok ? "#16a34a" : "#dc2626";
  }

  function startCountdown(btn) {
    var left = 60;
    btn.disabled = true;
    var timer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = "发送验证码";
      } else {
        btn.textContent = left + "s 后重发";
      }
    }, 1000);
    timers.push(timer);
  }

  function sendCode(channel, btn) {
    var target =
      channel === "email"
        ? (form.email.value || "").trim()
        : (form.phone.value || "").trim();
    if (!target) {
      say(channel === "email" ? "请先填写邮箱" : "请先填写手机号", false);
      return;
    }
    btn.disabled = true;
    fetch("/api/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channel, target: target, purpose: "register" }),
    })
      .then(async function (res) {
        if (res.ok) {
          startCountdown(btn);
          say("验证码已发送，10 分钟内有效", true);
          return;
        }
        var data = {};
        try {
          data = await res.json();
        } catch (e) {}
        btn.disabled = false;
        say(data.error || "发送失败，请稍后再试", false);
      })
      .catch(function () {
        btn.disabled = false;
        say("网络异常，请稍后再试", false);
      });
  }

  form.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-oboe-reg-send]") : null;
    if (!btn || !form.contains(btn) || btn.disabled) return;
    sendCode(btn.getAttribute("data-oboe-reg-send"), btn);
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    say("");
    var name = (form.name.value || "").trim();
    var email = (form.email.value || "").trim();
    var phone = (form.phone.value || "").trim();
    var password = form.password.value || "";
    var inviteCode = form.inviteCode ? (form.inviteCode.value || "").trim() : "";

    if (flag("data-name-required") && name.length < 2) return say("昵称至少 2 个字符", false);
    if (name && name.length > 32) return say("昵称最多 32 个字符", false);
    if (password && password.length < 8) return say("密码至少 8 位", false);
    if (flag("data-password-required") && !password) return say("请填写密码", false);
    if (flag("data-email-required") && !email) return say("请填写邮箱", false);
    if (flag("data-phone-required") && !phone) return say("请填写手机号", false);
    if (form.emailCode && email && !(form.emailCode.value || "").trim())
      return say("请填写邮箱验证码", false);
    if (form.phoneCode && phone && !(form.phoneCode.value || "").trim())
      return say("请填写手机验证码", false);
    if (flag("data-invite-only") && !inviteCode) return say("请填写邀请码", false);

    submitBtn.disabled = true;
    submitBtn.textContent = "注册中…";
    var payload = {};
    if (name) payload.name = name;
    if (email) payload.email = email;
    if (phone) payload.phone = phone;
    if (password) payload.password = password;
    if (inviteCode) payload.inviteCode = inviteCode;
    if (form.emailCode && email) payload.emailCode = (form.emailCode.value || "").trim();
    if (form.phoneCode && phone) payload.phoneCode = (form.phoneCode.value || "").trim();

    fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async function (res) {
        if (res.ok) {
          say("注册成功，正在进入…", true);

          window.location.href = "/";
          return;
        }
        var data = {};
        try {
          data = await res.json();
        } catch (e) {}
        say(data.error || "注册失败，请稍后再试", false);
      })
      .catch(function () {
        say("网络异常，请稍后再试", false);
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "注 册";
      });
  });

  window.addEventListener("pagehide", function () {
    timers.forEach(clearInterval);
  });
})();
