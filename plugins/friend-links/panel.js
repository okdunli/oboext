/**
 * friend-links admin panel behaviour (external script: the admin document's
 * strict CSP allows 'self' scripts only, so a plugin ships its JS as a file
 * under plugins/<slug>/ and mounts it at /plugin-assets/<slug>/panel.js).
 *
 * Delegated, zero-dependency: add / remove / reorder rows, collect the form,
 * PATCH /api/plugins/friend-links. On save the page reloads so the server
 * re-renders the panel from the new settings (the zero-JS admin's whole-page
 * navigation model).
 */
(function () {
  var root = document.querySelector("[data-fl-panel]");
  if (!root) return;
  // R531: the server renders the panel with a dictionary on the root element.
  var I = {};
  try {
    I = JSON.parse(root.getAttribute("data-i18n") || "{}") || {};
  } catch (e) {
    I = {};
  }
  var msg = root.querySelector("[data-fl-msg]");
  var saveBtn = root.querySelector('[data-fl-act="save"]');
  function flash(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = ok ? "#4ade80" : "#fca5a5";
  }
  function field(row, name) {
    var el = row.querySelector('[data-fl-f="' + name + '"]');
    return el ? el.value : "";
  }
  function collect() {
    var links = [];
    root.querySelectorAll("[data-fl-row]").forEach(function (row) {
      var vis = row.querySelector('[data-fl-f="visible"]');
      links.push({
        id: "l" + Math.random().toString(36).slice(2, 9),
        name: field(row, "name"),
        url: field(row, "url"),
        avatar: field(row, "avatar") || undefined,
        description: field(row, "description") || undefined,
        group: field(row, "group") || undefined,
        visible: vis ? vis.checked : true,
      });
    });
    function set(name) {
      var el = root.querySelector('[data-fl-set="' + name + '"]');
      if (!el) return undefined;
      return el.type === "checkbox" ? el.checked : el.value;
    }
    return {
      settings: {
        links: links,
        columns: set("columns"),
        showDescription: set("showDescription"),
        openNewTab: set("openNewTab"),
        routeEnabled: set("routeEnabled"),
        routePath: set("routePath"),
        pageTitle: set("pageTitle"),
      },
    };
  }
  function save() {
    if (saveBtn) saveBtn.disabled = true;
    flash(I.saving, true);
    fetch("/api/plugins/friend-links", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collect()),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && res.j.error) || I.save_failed);
        flash(I.saved, true);
        setTimeout(function () {
          location.reload();
        }, 250);
      })
      .catch(function (err) {
        flash(String((err && err.message) || err), false);
        if (saveBtn) saveBtn.disabled = false;
      });
  }
  root.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-fl-act]") : null;
    if (!btn || !root.contains(btn)) return;
    var act = btn.getAttribute("data-fl-act");
    if (act === "add") {
      var tpl = root.querySelector("template[data-fl-tpl]");
      if (tpl && tpl.content.firstElementChild) {
        root.querySelector("[data-fl-rows]").appendChild(tpl.content.firstElementChild.cloneNode(true));
      }
    } else if (act === "del") {
      var row = btn.closest("[data-fl-row]");
      if (row) row.remove();
    } else if (act === "up" || act === "down") {
      var r = btn.closest("[data-fl-row]");
      if (!r) return;
      if (act === "up" && r.previousElementSibling) r.parentNode.insertBefore(r, r.previousElementSibling);
      if (act === "down" && r.nextElementSibling) r.parentNode.insertBefore(r.nextElementSibling, r);
    } else if (act === "save") {
      save();
    }
  });
})();
