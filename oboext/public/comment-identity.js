// Remember the guest commenter's name / email / link between visits. The form
// is rendered empty on every page, so a reader who comments on two posts types
// the same three fields twice. localStorage only; nothing leaves the browser.
(function () {
  "use strict";
  var KEY = "oboext_comment_identity";

  function fields() {
    var form = document.querySelector("[data-comment-form]");
    if (!form) return null;
    var name = form.querySelector('input[name="authorName"]');
    if (!name) return null; // signed in: the form has no guest fields
    return {
      name: name,
      email: form.querySelector('input[name="authorEmail"]'),
      url: form.querySelector('input[name="authorUrl"]'),
    };
  }

  function load() {
    var f = fields();
    if (!f) return;
    var data = null;
    try {
      data = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch (e) {
      data = null;
    }
    if (!data) return;
    if (!f.name.value && data.name) f.name.value = data.name;
    if (f.email && !f.email.value && data.email) f.email.value = data.email;
    if (f.url && !f.url.value && data.url) f.url.value = data.url;
  }

  function save() {
    var f = fields();
    if (!f) return;
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          name: f.name.value.trim(),
          email: f.email ? f.email.value.trim() : "",
          url: f.url ? f.url.value.trim() : "",
        }),
      );
    } catch (e) {
      /* private mode / quota: not worth surfacing */
    }
  }

  function boot() {
    load();
    var f = fields();
    if (!f || f.name.getAttribute("data-identity-bound")) return;
    f.name.setAttribute("data-identity-bound", "1");
    var targets = [f.name, f.email, f.url];
    for (var i = 0; i < targets.length; i++) {
      if (!targets[i]) continue;
      targets[i].addEventListener("change", save);
      targets[i].addEventListener("blur", save);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  document.addEventListener("rv:nav", boot);
})();
