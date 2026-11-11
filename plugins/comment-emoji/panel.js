/**
 * comment-emoji admin panel behaviour (external script: the admin document's
 * strict CSP allows 'self' scripts only, so a plugin ships its JS as a file
 * under plugins/<slug>/ and mounts it at /plugin-assets/<slug>/panel.js).
 *
 * Owns the `groups` settings blob. Every mutation PATCHes
 * { settings: { ...current, groups } } so the front desk reflects it on the
 * next request. Zero dependencies, fully delegated.
 *
 * Data shape (must match plugins/comment-emoji/index.ts):
 *   groups: [{ name, icon, items: [{ type:"text", value, title? }
 *                                  | { type:"image", url, title? }] }]
 */
(function () {
  "use strict";

  var root = document.querySelector("[data-ce-panel]");
  if (!root) return;
  // R531: the server renders the panel with a dictionary on the root element.
  var I = {};
  try {
    I = JSON.parse(root.getAttribute("data-i18n") || "{}") || {};
  } catch (e) {
    I = {};
  }
  function tpl(str, vars) {
    return String(str || "").replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] != null ? String(vars[k]) : m;
    });
  }

  var stateEl = root.querySelector("[data-ce-state]");
  function state(text, ok) {
    if (!stateEl) return;
    stateEl.textContent = text || "";
    stateEl.style.color = ok ? "#4ade80" : ok === false ? "#fca5a5" : "";
  }

  var groups = [];

  function clone(tplAttr) {
    var tpl = root.querySelector("template[" + tplAttr + "]");
    return tpl && tpl.content.firstElementChild
      ? tpl.content.firstElementChild.cloneNode(true)
      : null;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ------------------------------------------------------------- rendering */

  function paintIconPicker(input) {
    // the shared icon-picker enhances [data-icon-picker] inputs; repaint after
    // a programmatic value change so the trigger button follows.
    if (input.__icpPaint) input.__icpPaint();
  }

  function fillItem(row, it) {
    row.querySelector('[data-ce-i-type]').value = it.type === "image" ? "image" : "text";
    var val = row.querySelector("[data-ce-i-value]");
    var url = row.querySelector("[data-ce-i-url]");
    var img = row.querySelector("[data-ce-i-image]");
    val.value = it.type === "image" ? "" : it.value || "";
    url.value = it.type === "image" ? it.url || "" : "";
    row.querySelector("[data-ce-i-title]").value = it.title || "";
    syncItemType(row);
  }

  function syncItemType(row) {
    var isImg = row.querySelector("[data-ce-i-type]").value === "image";
    row.querySelector("[data-ce-i-value]").style.display = isImg ? "none" : "";
    row.querySelector("[data-ce-i-image]").style.display = isImg ? "flex" : "none";
  }

  function readItem(row) {
    var isImg = row.querySelector("[data-ce-i-type]").value === "image";
    var title = row.querySelector("[data-ce-i-title]").value.trim();
    if (isImg) {
      var url = row.querySelector("[data-ce-i-url]").value.trim();
      if (!url) return null;
      return { type: "image", url: url, title: title || undefined };
    }
    var v = row.querySelector("[data-ce-i-value]").value;
    if (!v) return null;
    return { type: "text", value: v, title: title || undefined };
  }

  function renderGroups() {
    var holder = root.querySelector("[data-ce-groups]");
    holder.innerHTML = "";
    if (!groups.length) {
      holder.innerHTML =
        '<p class="adm-empty" style="border:1px dashed var(--adm-border);border-radius:var(--adm-radius);padding:22px 16px;margin:0;">' +
        I.empty_groups + "</p>";
      return;
    }
    groups.forEach(function (g) {
      var row = clone("data-ce-tpl-group");
      var icon = row.querySelector("[data-ce-g-icon]");
      icon.value = g.icon || "";
      paintIconPicker(icon);
      row.querySelector("[data-ce-g-name]").value = g.name || "";
      var items = row.querySelector("[data-ce-items]");
      (g.items || []).forEach(function (it) {
        var ir = clone("data-ce-tpl-item");
        fillItem(ir, it);
        items.appendChild(ir);
      });
      if (!(g.items || []).length) {
        items.innerHTML =
          '<p class="adm-hint" style="margin:4px 0;">' + I.empty_items + '</p>';
      }
      holder.appendChild(row);
    });
  }

  /* -------------------------------------------------------------- reading */

  function readGroupsFromDom() {
    var out = [];
    root.querySelectorAll("[data-ce-group]").forEach(function (row) {
      var icon = row.querySelector("[data-ce-g-icon]");
      var items = [];
      row.querySelectorAll("[data-ce-item]").forEach(function (ir) {
        var it = readItem(ir);
        if (it) items.push(it);
      });
      out.push({
        name: row.querySelector("[data-ce-g-name]").value.trim() || I.unnamed,
        icon: icon.value.trim() || "smile",
        items: items,
      });
    });
    return out;
  }

  /* -------------------------------------------------------------- saving */

  var saving = false;
  function save() {
    if (saving) return;
    groups = readGroupsFromDom();
    saving = true;
    state(I.saving);
    // Re-read the full settings so the panel's own fields (sizes, switches)
    // are preserved — this panel only owns `groups`.
    fetch("/api/plugins/comment-emoji", {
      headers: { accept: "application/json" },
    })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (cur) {
        var all = (cur && cur.resolvedSettings) || {};
        return fetch("/api/plugins/comment-emoji", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ settings: Object.assign({}, all, { groups: groups }) }),
        });
      })
      .then(function (r) {
        if (!r.ok) throw new Error("save failed");
        state(tpl(I.saved_n, { n: groups.length }), true);
      })
      .catch(function () {
        state(I.save_failed, false);
      })
      .then(function () {
        saving = false;
      });
  }

  /** Debounced autosave — the panel stays live while typing. */
  var t = null;
  function autosave() {
    clearTimeout(t);
    t = setTimeout(save, 500);
  }

  /* --------------------------------------------------------- import/export */

  function doExport() {
    var json = JSON.stringify({ groups: readGroupsFromDom() }, null, 2);
    var box = document.createElement("textarea");
    box.value = json;
    box.style.cssText =
      "position:fixed;left:20px;top:20px;width:60vw;height:70vh;z-index:9999;padding:12px;";
    document.body.appendChild(box);
    box.select();
    state(I.exported, true);
  }

  function doImport() {
    var raw = window.prompt(I.import_prompt);
    if (!raw) return;
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      state(I.import_bad_json, false);
      return;
    }
    var list = Array.isArray(data) ? data : data && data.groups;
    if (!Array.isArray(list)) {
      state(I.import_bad_shape, false);
      return;
    }
    groups = list;
    renderGroups();
    save();
  }

  /* ---------------------------------------------------------------- media */

  var mediaBox = null;
  function openMedia(urlInput) {
    if (mediaBox) mediaBox.remove();
    mediaBox = document.createElement("div");
    mediaBox.className = "adm-modal";
    mediaBox.hidden = false;
    mediaBox.innerHTML =
      '<div class="adm-modal-box" style="max-width:760px;">' +
      '<div class="adm-modal-hd"><strong>' + I.media_title + '</strong><span style="flex:1"></span>' +
      '<button type="button" class="adm-iconbtn" data-ce-media-close title="' + I.close + '">×</button></div>' +
      '<div class="adm-modal-bd" data-ce-media-body><p class="adm-hint">' + I.loading + '</p></div>' +
      "</div>";
    document.body.appendChild(mediaBox);
    mediaBox
      .querySelector("[data-ce-media-close]")
      .addEventListener("click", function () {
        mediaBox.remove();
        mediaBox = null;
      });
    fetch("/api/media?limit=60", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (d) {
        var items = (d && d.items) || [];
        var body = mediaBox && mediaBox.querySelector("[data-ce-media-body]");
        if (!body) return;
        if (!items.length) {
          body.innerHTML = '<p class="adm-hint">' + I.media_empty + '</p>';
          return;
        }
        body.innerHTML =
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;">' +
          items
            .map(function (m) {
              var isImg = String(m.mimeType || "").indexOf("image/") === 0;
              var prev = isImg
                ? '<img src="' + esc(m.url) + '" alt="" style="width:100%;height:76px;object-fit:cover;border-radius:6px;">'
                : '<div style="height:76px;display:flex;align-items:center;justify-content:center;font-size:11px;opacity:.6;">' + esc(m.mimeType || "file") + "</div>";
              return (
                '<button type="button" data-ce-media-url="' + esc(m.url) + '" title="' + esc(m.filename || "") + '" style="border:1px solid var(--adm-border);border-radius:8px;padding:6px;background:transparent;cursor:pointer;text-align:left;">' +
                prev +
                '<div style="font-size:11px;opacity:.65;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(m.filename || m.url) + "</div>" +
                "</button>"
              );
            })
            .join("") +
          "</div>";
        body.querySelectorAll("[data-ce-media-url]").forEach(function (b) {
          b.addEventListener("click", function () {
            urlInput.value = b.getAttribute("data-ce-media-url");
            mediaBox.remove();
            mediaBox = null;
            autosave();
          });
        });
      })
      .catch(function () {
        var body = mediaBox && mediaBox.querySelector("[data-ce-media-body]");
        if (body) body.innerHTML = '<p class="adm-hint">' + I.media_failed + '</p>';
      });
  }

  /* --------------------------------------------------------------- events */

  root.addEventListener("click", function (e) {
    var addGroup = e.target.closest("[data-ce-add-group]");
    if (addGroup) {
      groups.push({ name: I.new_group, icon: "smile", items: [] });
      renderGroups();
      autosave();
      return;
    }
    if (e.target.closest("[data-ce-export]")) { doExport(); return; }
    if (e.target.closest("[data-ce-import]")) { doImport(); return; }

    var gUp = e.target.closest("[data-ce-g-up]");
    if (gUp) {
      var gr = gUp.closest("[data-ce-group]");
      var list = Array.prototype.slice.call(root.querySelectorAll("[data-ce-group]"));
      var i = list.indexOf(gr);
      if (i > 0) {
        groups = readGroupsFromDom();
        var tmp = groups[i - 1];
        groups[i - 1] = groups[i];
        groups[i] = tmp;
        renderGroups();
        autosave();
      }
      return;
    }
    var gDown = e.target.closest("[data-ce-g-down]");
    if (gDown) {
      var gr2 = gDown.closest("[data-ce-group]");
      var list2 = Array.prototype.slice.call(root.querySelectorAll("[data-ce-group]"));
      var j = list2.indexOf(gr2);
      if (j >= 0 && j < groups.length - 1) {
        groups = readGroupsFromDom();
        var tmp2 = groups[j + 1];
        groups[j + 1] = groups[j];
        groups[j] = tmp2;
        renderGroups();
        autosave();
      }
      return;
    }
    var gDel = e.target.closest("[data-ce-g-del]");
    if (gDel) {
      if (!window.confirm(I.confirm_del_group)) return;
      var gr3 = gDel.closest("[data-ce-group]");
      var list3 = Array.prototype.slice.call(root.querySelectorAll("[data-ce-group]"));
      var k = list3.indexOf(gr3);
      groups = readGroupsFromDom();
      groups.splice(k, 1);
      renderGroups();
      autosave();
      return;
    }

    var itemAdd = e.target.closest("[data-ce-item-add]");
    if (itemAdd) {
      var gr4 = itemAdd.closest("[data-ce-group]");
      var list4 = Array.prototype.slice.call(root.querySelectorAll("[data-ce-group]"));
      var gi = list4.indexOf(gr4);
      groups = readGroupsFromDom();
      groups[gi].items.push({ type: "text", value: "" });
      renderGroups();
      return;
    }

    var iUp = e.target.closest("[data-ce-i-up]");
    if (iUp) {
      var row = iUp.closest("[data-ce-item]");
      var prev = row.previousElementSibling;
      if (prev && prev.hasAttribute("data-ce-item")) {
        row.parentNode.insertBefore(row, prev);
        autosave();
      }
      return;
    }
    var iDown = e.target.closest("[data-ce-i-down]");
    if (iDown) {
      var row2 = iDown.closest("[data-ce-item]");
      var next = row2.nextElementSibling;
      if (next && next.hasAttribute("data-ce-item")) {
        row2.parentNode.insertBefore(next, row2);
        autosave();
      }
      return;
    }
    var iDel = e.target.closest("[data-ce-i-del]");
    if (iDel) {
      iDel.closest("[data-ce-item]").remove();
      autosave();
      return;
    }

    var mediaBtn = e.target.closest("[data-ce-i-media]");
    if (mediaBtn) {
      var row3 = mediaBtn.closest("[data-ce-item]");
      openMedia(row3.querySelector("[data-ce-i-url]"));
      return;
    }
  });

  // type switch + any edit -> autosave
  root.addEventListener("change", function (e) {
    if (e.target.matches("[data-ce-i-type]")) {
      syncItemType(e.target.closest("[data-ce-item]"));
      autosave();
      return;
    }
    if (e.target.matches("[data-ce-g-icon]")) autosave();
  });
  root.addEventListener("input", function (e) {
    if (e.target.matches("input, textarea")) autosave();
  });

  /* ------------------------------------------------------------------ boot */

  // resolveSettings ships the machine-managed blob; read it back from the API
  // so this panel never trusts a stale server render.
  fetch("/api/plugins/comment-emoji", { headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (d) {
      var all = (d && d.resolvedSettings) || {};
      groups = Array.isArray(all.groups) ? all.groups : [];
    })
    .catch(function () { groups = []; })
    .then(function () {
      renderGroups();
      if (!groups.length) state(I.state_empty);
      else state(tpl(I.state_n, { n: groups.length }), true);
    });
})();
