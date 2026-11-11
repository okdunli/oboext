// Guest comment captcha (opt-in: OBOEXT_COMMENT_CAPTCHA=1). The server renders
// the empty widget; this fills it from /api/comment-captcha and rides the two
// fields onto the /api/comments POST body. comments.js builds that body itself,
// so the wrapper below is the only place that can add them — csrf.js wraps
// fetch for the same reason.
(function () {
  "use strict";
  function box() {
    return document.querySelector("[data-comment-captcha]");
  }
  function refresh() {
    var host = box();
    if (!host) return;
    var slot = host.querySelector("[data-captcha-svg]");
    var token = host.querySelector("input[name=captchaToken]");
    var answer = host.querySelector("input[name=captchaAnswer]");
    if (token) token.value = "";
    if (answer) answer.value = "";
    fetch("/api/comment-captcha", { credentials: "same-origin", cache: "no-store" })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data || !slot || !token) return;
        slot.innerHTML = data.svg || "";
        token.value = data.token || "";
      })
      .catch(function () {});
  }
  if (window.fetch && !window.__oboeCommentCaptcha) {
    window.__oboeCommentCaptcha = true;
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      var onComments = typeof url === "string" && url.indexOf("/api/comments") === 0;
      if (onComments && init && typeof init.body === "string") {
        var host = box();
        if (host) {
          var token = host.querySelector("input[name=captchaToken]");
          var answer = host.querySelector("input[name=captchaAnswer]");
          try {
            var payload = JSON.parse(init.body);
            payload.captchaToken = token ? token.value : "";
            payload.captchaAnswer = answer ? answer.value : "";
            init = Object.assign({}, init, { body: JSON.stringify(payload) });
          } catch (e) {
            /* not our body shape: leave it alone */
          }
        }
      }
      var out = nativeFetch.call(this, input, init);
      // A token is burned on the first attempt, so every submit needs a fresh
      // challenge — right or wrong.
      if (onComments) out.then(refresh, refresh);
      return out;
    };
  }
  function boot() {
    var host = box();
    if (!host) return;
    var token = host.querySelector("input[name=captchaToken]");
    if (!token || !token.value) refresh();
    var slot = host.querySelector("[data-captcha-svg]");
    if (slot && !slot.getAttribute("data-captcha-bound")) {
      slot.setAttribute("data-captcha-bound", "1");
      slot.addEventListener("click", refresh);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  document.addEventListener("rv:nav", boot);
})();
