// "Choose from library" for the featured-image fields. The editor only offered
// a free-text URL box, so an author had to open the media library in another
// tab, copy an address and paste it. This picks the URL from a thumbnail grid
// (the same 400px variants the library grid uses).
(function () {
  "use strict";
  var overlay = null;

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function fieldOf(btn) {
    var box = btn.closest ? btn.closest(".adm-field") : null;
    return box ? box.querySelector('input[name="featuredImage"]') : null;
  }

  function previewOf(btn) {
    var box = btn.closest ? btn.closest(".adm-field") : null;
    return box ? box.querySelector("[data-featured-preview]") : null;
  }

  function syncPreview(input, img) {
    if (!input || !img) return;
    var v = String(input.value || "").trim();
    if (v) {
      img.src = v;
      img.style.display = "";
    } else {
      img.removeAttribute("src");
      img.style.display = "none";
    }
  }

  function choose(url, alt) {
    var target = currentTarget;
    var preview = currentPreview;
    close();
    if (!target) return;
    target.value = url;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    // The library carries an alt text; a block image picked from it inherits
    // it unless the author already typed one - an empty alt is a legitimate
    // decorative-image choice, never overwritten.
    if (alt) {
      var block = target.closest ? target.closest(".adm-block") : null;
      var altInput = block ? block.querySelector('input[data-f="alt"]') : null;
      if (altInput && !String(altInput.value || "").trim()) {
        altInput.value = alt;
        altInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    if (preview) syncPreview(target, preview);
  }

  var currentTarget = null;
  var currentPreview = null;

  function openPicker(target, preview) {
    currentTarget = target;
    currentPreview = preview || null;
    overlay = document.createElement("div");
    overlay.setAttribute("data-media-picker", "1");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px";
    var panel = document.createElement("div");
    panel.style.cssText =
      "width:min(880px,100%);max-height:80vh;overflow:auto;background:var(--adm-surface,#18181b);border:1px solid var(--adm-border,#3f3f46);border-radius:12px;padding:16px";
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<strong style="color:var(--adm-text,#fafafa)">' +
      (document.documentElement.lang === "en" ? "Media library" : "媒体库") +
      "</strong>" +
      '<button type="button" data-picker-close style="background:none;border:0;color:var(--adm-muted,#a1a1aa);font-size:20px;cursor:pointer;line-height:1">&times;</button>' +
      "</div>" +
      '<div data-picker-grid style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px"></div>';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    panel.querySelector("[data-picker-close]").addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", esc);
        close();
      }
    });

    var grid = panel.querySelector("[data-picker-grid]");
    var PAGE = 60;
    var loaded = 0;
    var moreBtn = null;
    var itemHtml = function (m) {
      var src = m.thumbUrl || m.url;
      return (
        '<button type="button" data-pick-url="' + String(m.url).replace(/"/g, "&quot;") + '" ' +
        'data-pick-alt="' + String(m.alt || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") + '" ' +
        'style="padding:0;border:1px solid var(--adm-border,#3f3f46);border-radius:8px;overflow:hidden;background:none;cursor:pointer;aspect-ratio:1/1">' +
        '<img src="' + String(src).replace(/"/g, "&quot;") + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">' +
        "</button>"
      );
    };
    // A full page means more may exist: swap in a load-more row so a large
    // library stays reachable (the API pages on offset; newest first, so
    // appended pages keep the order).
    var loadMore = function () {
      if (moreBtn) moreBtn.remove();
      moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.style.cssText =
        "grid-column:1/-1;padding:8px;border:1px dashed var(--adm-border,#3f3f46);border-radius:8px;background:none;color:var(--adm-muted,#a1a1aa);font-size:13px;cursor:pointer";
      moreBtn.textContent = document.documentElement.lang === "en" ? "Load more" : "加载更多";
      moreBtn.addEventListener("click", function () { fetchPage(); });
      grid.appendChild(moreBtn);
    };
    var fetchPage = function () {
      if (moreBtn) moreBtn.textContent = document.documentElement.lang === "en" ? "Loading…" : "加载中…";
      fetch("/api/media?type=image&limit=" + PAGE + "&offset=" + loaded, { credentials: "same-origin" })
        .then(function (res) {
          return res.ok ? res.json() : { items: [] };
        })
        .then(function (data) {
          var items = (data && data.items) || [];
          loaded += items.length;
          if (!loaded && !items.length) {
            if (moreBtn) moreBtn.remove();
            grid.innerHTML =
              '<p style="color:var(--adm-muted,#a1a1aa);font-size:13px">' +
              (document.documentElement.lang === "en" ? "No images yet." : "媒体库还没有图片。") +
              "</p>";
            return;
          }
          var frag = document.createElement("div");
          frag.innerHTML = items.map(itemHtml).join("");
          while (frag.firstChild) grid.appendChild(frag.firstChild);
          if (items.length >= PAGE) loadMore();
          else if (moreBtn) moreBtn.remove();
        })
        .catch(close);
    };
    fetchPage();
    grid.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-pick-url]") : null;
      if (b) choose(b.getAttribute("data-pick-url"), b.getAttribute("data-pick-alt"));
    });
  }

  function boot() {
    var buttons = document.querySelectorAll("[data-media-pick]");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        if (btn.getAttribute("data-pick-bound")) return;
        btn.setAttribute("data-pick-bound", "1");
        btn.addEventListener("click", function () {
          openPicker(fieldOf(btn), previewOf(btn));
        });
        var input = fieldOf(btn);
        var img = previewOf(btn);
        if (input) {
          input.addEventListener("input", function () {
            syncPreview(input, img);
          });
          syncPreview(input, img);
        }
      })(buttons[i]);
    }
  }
  // Body-block image rows are built by admin.js (minified) with data-f="url"
  // and no picker. Decorate them here: same modal, same 400px grid.
  function decorateBlocks() {
    var rows = document.querySelectorAll(".adm-block");
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var type = row.querySelector('select[data-f="type"]');
        var input = row.querySelector('input[data-f="url"]');
        if (!type || !input) return;
        if (type.value !== "image") {
          var stale = row.querySelector("[data-block-pick]");
          if (stale) stale.parentNode.removeChild(stale);
          return;
        }
        if (row.querySelector("[data-block-pick]")) return;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "adm-btn adm-btn-ghost adm-btn-sm";
        btn.setAttribute("data-block-pick", "1");
        btn.textContent = document.documentElement.lang === "en" ? "Choose from library" : "从媒体库选择";
        btn.addEventListener("click", function () {
          openPicker(input, null);
        });
        input.parentNode.insertBefore(btn, input.nextSibling);
      })(rows[i]);
    }
  }
  // Schema-driven forms (site settings, theme panel, widget options) render an
  // image field as .adm-wg-img with a preview and a data-k input - again URL
  // only. Same modal, same grid.
  function decorateImageWidgets() {
    var boxes = document.querySelectorAll(".adm-wg-img");
    for (var i = 0; i < boxes.length; i++) {
      (function (box) {
        if (box.querySelector("[data-widget-pick]")) return;
        var input = box.querySelector("input[data-k]");
        var prev = box.querySelector(".adm-wg-img-prev");
        if (!input) return;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "adm-btn adm-btn-ghost adm-btn-sm";
        btn.setAttribute("data-widget-pick", "1");
        btn.textContent = document.documentElement.lang === "en" ? "Choose" : "选择图片";
        btn.addEventListener("click", function () {
          openPicker(input, prev);
        });
        var row = box.querySelector(".adm-wg-img-row") || box;
        row.appendChild(btn);
      })(boxes[i]);
    }
  }
  function bootAll() {
    boot();
    decorateBlocks();
    decorateImageWidgets();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootAll);
  else bootAll();
  if (window.MutationObserver && document.body) {
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () {
        queued = false;
        decorateBlocks();
        decorateImageWidgets();
      }, 0);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
