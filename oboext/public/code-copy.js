// Copy button for code blocks. The server already stamps <pre data-lang="…">,
// so this only decorates: one button in the block's corner, text from the
// document language (one file serves both catalogs). pjax swaps #sk-main
// without a document load, so rv:nav re-attaches.
(function () {
  "use strict";

  var ZH = { copy: "复制", done: "已复制", fail: "复制失败" };
  var EN = { copy: "Copy", done: "Copied", fail: "Copy failed" };
  function labels() {
    return (document.documentElement.lang || "").toLowerCase().indexOf("en") === 0 ? EN : ZH;
  }
  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  }
  function attach() {
    var all = document.querySelectorAll("pre[data-lang]");
    var blocks = document.querySelectorAll("pre[data-lang]:not([data-copy-ready])");
    for (var i = 0; i < blocks.length; i++) {
      (function (pre) {
        var code = pre.querySelector("code");
        if (!code) return;
        pre.setAttribute("data-copy-ready", "1");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "code-copy";
        btn.textContent = labels().copy;
        btn.setAttribute("aria-label", labels().copy);
        btn.addEventListener("click", function () {
          var L = labels();
          writeClipboard(code.textContent || "").then(
            function () {
              btn.textContent = L.done;
              btn.classList.add("is-done");
              setTimeout(function () {
                btn.textContent = L.copy;
                btn.classList.remove("is-done");
              }, 1600);
            },
            function () {
              btn.textContent = L.fail;
              setTimeout(function () {
                btn.textContent = L.copy;
              }, 1600);
            },
          );
        });
        pre.appendChild(btn);
        pre.classList.add("has-copy");
      })(blocks[i]);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
  document.addEventListener("rv:nav", attach);
  // The framework hydrates the SSR body after load and swaps the whole
  // #sk-main subtree, which drops the buttons attached above. Watch for that
  // (and for any later body swap) and re-decorate; attach() is idempotent, so
  // the mutation it causes itself ends the loop.
  if (window.MutationObserver && document.body) {
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () {
        queued = false;
        attach();
      }, 0);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
