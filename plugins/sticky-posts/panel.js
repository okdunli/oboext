/**
 * sticky-posts admin panel behaviour (external script: the admin document's
 * strict CSP allows 'self' scripts only, so a plugin ships its JS as a file
 * under plugins/<slug>/ and mounts it at /plugin-assets/<slug>/panel.js).
 *
 * Port of the original admin.tsx data flow: the catalogue streams in from
 * /api/posts (pages of 100), the current order comes from
 * /api/plugins/sticky-posts (resolvedSettings), and every mutation PATCHes
 * { settings: { ids, includeHome } } immediately so the front desk reflects
 * it on the next request. Zero dependencies, fully delegated.
 */
(function () {
  "use strict";
  var root = document.querySelector("[data-sp-panel]");
  if (!root) return;
  // R531: the server renders the panel with a dictionary on the root element.
  var I = {};
  try {
    I = JSON.parse(root.getAttribute("data-i18n") || "{}") || {};
  } catch (e) {
    I = {};
  }

  var PAGE = 100;
  var ids = [];
  var includeHome = true;
  var posts = [];
  var byId = {};
  var total = 0;
  var kw = "";
  var saving = false;

  var stateEl = root.querySelector("[data-sp-state]");
  function state(text, ok) {
    if (!stateEl) return;
    stateEl.textContent = text || "";
    stateEl.style.color = ok ? "#4ade80" : ok === false ? "#fca5a5" : "";
  }

  function fmt(date) {
    if (!date) return "—";
    var d = new Date(date);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  }

  function fillRow(row, p) {
    row.setAttribute("data-sp-post-id", String(p.id));
    row.querySelector("[data-sp-title]").textContent = p.title || I.untitled;
    row.querySelector("[data-sp-status]").textContent =
      p.status === "published" ? I.st_published : p.status === "draft" ? I.st_draft : p.status || "";
    row.querySelector("[data-sp-id]").textContent = "#" + p.id;
    row.querySelector("[data-sp-date]").textContent = fmt(p.publishedAt || p.createdAt);
  }

  function clone(tplAttr) {
    var tpl = root.querySelector("template[" + tplAttr + "]");
    return tpl && tpl.content.firstElementChild
      ? tpl.content.firstElementChild.cloneNode(true)
      : null;
  }

  function renderPinned() {
    var holder = root.querySelector("[data-sp-pinned]");
    holder.innerHTML = "";
    if (!ids.length) {
      holder.innerHTML =
        '<p class="adm-empty" style="border:1px dashed var(--adm-border);border-radius:var(--adm-radius);padding:22px 16px;margin:0;">' +
        I.empty_pinned + "</p>";
      return;
    }
    ids.forEach(function (id, i) {
      var p = byId[id];
      if (!p) return;
      var row = clone("data-sp-tpl-pinned");
      if (!row) return;
      fillRow(row, p);
      var pos = row.querySelector("[data-sp-pos]");
      pos.value = String(i + 1);
      pos.max = String(ids.length);
      pos.disabled = ids.length < 2 || saving;
      row.querySelector('[data-sp-act="up"]').disabled = i === 0 || saving;
      row.querySelector('[data-sp-act="down"]').disabled = i === ids.length - 1 || saving;
      row.querySelector('[data-sp-act="unpin"]').disabled = saving;
      holder.appendChild(row);
    });
  }

  function renderCatalogue() {
    var holder = root.querySelector("[data-sp-catalogue]");
    var pinned = {};
    ids.forEach(function (id) { pinned[id] = 1; });
    var q = kw.trim().toLowerCase();
    var list = posts.filter(function (p) {
      if (pinned[p.id]) return false;
      if (!q) return true;
      return (
        (p.title || "").toLowerCase().indexOf(q) >= 0 ||
        (p.slug || "").toLowerCase().indexOf(q) >= 0
      );
    });
    holder.innerHTML = "";
    if (!list.length) {
      holder.innerHTML =
        '<p class="adm-empty" style="border:1px dashed var(--adm-border);border-radius:var(--adm-radius);padding:22px 16px;margin:0;">' +
        (q ? I.no_match : I.all_pinned) +
        "</p>";
    } else {
      list.forEach(function (p) {
        var row = clone("data-sp-tpl-cat");
        if (!row) return;
        fillRow(row, p);
        row.querySelector('[data-sp-act="pin"]').disabled = saving;
        holder.appendChild(row);
      });
    }
    var more = root.querySelector("[data-sp-more]");
    more.style.display = !q && posts.length < total ? "" : "none";
    more.disabled = saving;
    more.textContent = I.more_state
      ? I.more_state.replace("{shown}", String(posts.length)).replace("{total}", String(total))
      : "";
  }

  function renderAll() {
    renderPinned();
    renderCatalogue();
  }

  function persist(next, home) {
    saving = true;
    state(I.saving);
    renderAll();
    fetch("/api/plugins/sticky-posts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },

      body: JSON.stringify({ settings: { ids: next, includeHome: home } }),
    })
      .then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && res.j.error) || I.save_failed);
        ids = next;
        includeHome = home;
        state(I.saved, true);
      })
      .catch(function (err) {
        state(String((err && err.message) || err), false);
      })
      .finally(function () {
        saving = false;
        renderAll();
      });
  }

  function moveBy(index, delta) {
    var target = index + delta;
    if (target < 0 || target >= ids.length) return;
    var next = ids.slice();
    var item = next.splice(index, 1)[0];
    next.splice(target, 0, item);
    persist(next, includeHome);
  }

  function jumpTo(index, position1Based) {
    var clamped = Math.min(Math.max(position1Based, 1), ids.length);
    if (clamped === index + 1) return;
    var next = ids.slice();
    var item = next.splice(index, 1)[0];
    next.splice(clamped - 1, 0, item);
    persist(next, includeHome);
  }

  function pin(id) {
    if (ids.indexOf(id) >= 0) return;
    persist(ids.concat([id]), includeHome);
  }

  function unpin(id) {
    persist(
      ids.filter(function (x) { return x !== id; }),
      includeHome,
    );
  }

  root.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-sp-act]") : null;
    if (!btn || !root.contains(btn) || btn.disabled) return;
    var act = btn.getAttribute("data-sp-act");
    if (act === "pin") {
      var crow = btn.closest("[data-sp-crow]");
      var pid = Number(crow.getAttribute("data-sp-post-id"));
      if (pid) pin(pid);
      return;
    }
    var prow = btn.closest("[data-sp-prow]");
    if (!prow) return;
    var rows = Array.prototype.slice.call(root.querySelectorAll("[data-sp-prow]"));
    var i = rows.indexOf(prow);
    if (act === "up") moveBy(i, -1);
    else if (act === "down") moveBy(i, 1);
    else if (act === "unpin") {
      var uid = Number(prow.getAttribute("data-sp-post-id"));
      if (uid) unpin(uid);
    }
  });

  root.addEventListener("keydown", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-sp-pos") && e.key === "Enter") {
      e.target.blur();
    }
  });

  root.addEventListener("blur", function (e) {
    var t = e.target;
    if (!t.hasAttribute || !t.hasAttribute("data-sp-pos")) return;
    var rows = Array.prototype.slice.call(root.querySelectorAll("[data-sp-prow]"));
    var i = rows.indexOf(t.closest("[data-sp-prow]"));
    if (i < 0) return;
    var n = Number(t.value);
    if (isFinite(n)) jumpTo(i, Math.round(n));
  }, true);

  root.addEventListener("input", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-sp-search")) {
      kw = e.target.value || "";
      renderCatalogue();
    }
  });

  root.addEventListener("change", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-sp-set")) {
      persist(ids, e.target.checked);
    }
  });

  root.addEventListener("click", function (e) {
    var more = e.target.closest ? e.target.closest("[data-sp-more]") : null;
    if (!more || !root.contains(more) || more.disabled) return;
    more.disabled = true;
    fetch("/api/posts?limit=" + PAGE + "&offset=" + posts.length, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (json) {
        (json.items || []).forEach(function (p) {
          if (!byId[p.id]) {
            posts.push(p);
            byId[p.id] = p;
          }
        });
        renderCatalogue();
      })
      .catch(function () {})
      .finally(function () { more.disabled = false; });
  });

  // ------------------------------------------------------------------- boot
  function loadPage(offset) {
    return fetch("/api/posts?limit=" + PAGE + "&offset=" + offset, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { items: [], total: 0 }; });
  }

  function loadAll(offset, collected) {
    return loadPage(offset).then(function (json) {
      var items = json.items || [];
      collected = collected.concat(items);
      var t = typeof json.total === "number" ? json.total : collected.length;
      if (items.length < PAGE || collected.length >= t) return { items: collected, total: t };
      return loadAll(offset + items.length, collected);
    });
  }

  state(I.loading);
  Promise.all([
    loadAll(0, []),
    fetch("/api/plugins/sticky-posts", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; }),
  ]).then(function (res) {
    posts = res[0].items || [];
    total = res[0].total;
    posts.forEach(function (p) { byId[p.id] = p; });
    var resolved = (res[1] && res[1].resolvedSettings) || {};
    ids = Array.isArray(resolved.ids)
      ? resolved.ids.filter(function (n) { return Number.isInteger(n) && n > 0; })
      : [];
    includeHome = resolved.includeHome !== false;
    var cb = root.querySelector('[data-sp-set="includeHome"]');
    if (cb) cb.checked = includeHome;
    state(I.count ? I.count.replace("{total}", String(total)) : String(total));
    renderAll();
  });
})();
