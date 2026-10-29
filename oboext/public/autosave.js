(function () {
  "use strict";

  var PREFIX = "oboext:autosave:";
  var VERSION = 1;
  var MAX_BYTES = 1500000;
  var DEFAULT_TTL_DAYS = 7;
  var DEBOUNCE_MS = 2000;
  var DAY_MS = 86400000;

  function byteLen(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  function stableStringify(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) {
      var items = [];
      for (var i = 0; i < v.length; i++) items.push(stableStringify(v[i]));
      return "[" + items.join(",") + "]";
    }
    var keys = Object.keys(v).sort();
    var parts = [];
    for (var j = 0; j < keys.length; j++) {
      if (v[keys[j]] === undefined) continue;
      parts.push(JSON.stringify(keys[j]) + ":" + stableStringify(v[keys[j]]));
    }
    return "{" + parts.join(",") + "}";
  }

  function buildKey(kind, id) {
    var k = kind === "page" ? "page" : "post";
    var tail = id == null || id === "" ? "new" : String(id);
    return PREFIX + k + ":" + tail;
  }

  function isEmptyPayload(p) {
    if (!p || typeof p !== "object") return true;
    var blocks = Array.isArray(p.content) ? p.content.length : 0;
    var metas = Array.isArray(p.metas) ? p.metas.filter(function (m) { return m && (m.key || m.value); }).length : 0;
    var fm = p.formatMeta && typeof p.formatMeta === "object"
      ? Object.keys(p.formatMeta).filter(function (k) { return p.formatMeta[k] !== "" && p.formatMeta[k] != null; }).length
      : 0;
    var cats = Array.isArray(p.categoryIds) ? p.categoryIds.length : 0;
    var tags = Array.isArray(p.tagIds) ? p.tagIds.length : 0;
    return !(
      (p.title && String(p.title).trim()) ||
      (p.slug && String(p.slug).trim()) ||
      (p.excerpt && String(p.excerpt).trim()) ||
      (p.seoTitle && String(p.seoTitle).trim()) ||
      (p.seoDescription && String(p.seoDescription).trim()) ||
      (p.seoKeywords && String(p.seoKeywords).trim()) ||
      (p.featuredImage && String(p.featuredImage).trim()) ||
      blocks || metas || fm || cats || tags || p.pinned
    );
  }

  function serialize(snap) {
    var text;
    try {
      text = JSON.stringify(snap);
    } catch (e) {
      return null;
    }
    if (text == null || byteLen(text) > MAX_BYTES) return null;
    return text;
  }

  function deserialize(text) {
    if (typeof text !== "string" || !text) return null;
    var o;
    try {
      o = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!o || typeof o !== "object") return null;
    if (o.v !== VERSION) return null;
    if (typeof o.savedAt !== "number" || !isFinite(o.savedAt)) return null;
    if (!o.payload || typeof o.payload !== "object" || Array.isArray(o.payload)) return null;
    return o;
  }

  function isExpired(snap, ttlDays, now) {
    var days = typeof ttlDays === "number" && ttlDays > 0 ? ttlDays : DEFAULT_TTL_DAYS;
    return now - snap.savedAt > days * DAY_MS;
  }

  function samePayload(a, b) {
    return stableStringify(a || null) === stableStringify(b || null);
  }

  function formatTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    function pad(n) { return String(n).padStart(2, "0"); }
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function sweepExpired(ls, ttlDays, now) {
    var dead = [];
    try {
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(PREFIX) !== 0) continue;
        var snap = deserialize(ls.getItem(k));
        if (!snap || isExpired(snap, ttlDays, now)) dead.push(k);
      }
    } catch (e) {
      return;
    }
    for (var j = 0; j < dead.length; j++) {
      try { ls.removeItem(dead[j]); } catch (e) {}
    }
  }

  var core = {
    PREFIX: PREFIX,
    VERSION: VERSION,
    MAX_BYTES: MAX_BYTES,
    DEFAULT_TTL_DAYS: DEFAULT_TTL_DAYS,
    buildKey: buildKey,
    isEmptyPayload: isEmptyPayload,
    serialize: serialize,
    deserialize: deserialize,
    isExpired: isExpired,
    samePayload: samePayload,
    formatTime: formatTime,
    sweepExpired: sweepExpired,
    stableStringify: stableStringify,
  };

  var CSS = [
    ".xob-as-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;",
    "padding:10px 14px;margin:0 0 14px;border:1px solid #ecd9a8;border-radius:10px;",
    "background:#fff9e8;color:#6b5410;font-size:13px;line-height:1.5}",
    ".xob-as-banner .xob-as-dot{width:8px;height:8px;border-radius:50%;background:#d99a1f;flex:none}",
    ".xob-as-banner .xob-as-sp{flex:1}",
    ".xob-as-banner button{flex:none}",
  ].join("");

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var st = document.createElement("style");
    st.id = "xob-as-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function getStore() {
    try {
      var probe = "__oboext_as_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    } catch (e) {
      return null;
    }
  }

  function readTtlDays(root) {
    var raw = root.getAttribute("data-autosave-ttl");
    var n = raw == null ? NaN : Number(raw);
    return n > 0 ? n : DEFAULT_TTL_DAYS;
  }

  var SINGLE_FIELDS = [
    "title", "slug", "excerpt", "status", "publishedAt", "commentStatus",
    "authorId", "parentId", "order", "featuredImage", "format", "seoTitle", "seoDescription", "seoKeywords", "locale", "translationOf",
  ];

  function applyPayload(ed, p) {
    var root = ed.root;
    for (var i = 0; i < SINGLE_FIELDS.length; i++) {
      var name = SINGLE_FIELDS[i];
      if (!(name in p) || p[name] == null) continue;
      var el = root.querySelector('[name="' + name + '"]');
      if (el) el.value = String(p[name]);
    }
    function setChecks(sel, ids) {
      var all = root.querySelectorAll(sel);
      var want = {};
      (Array.isArray(ids) ? ids : []).forEach(function (v) { want[String(v)] = true; });
      for (var i = 0; i < all.length; i++) all[i].checked = !!want[String(all[i].value)];
    }
    if (ed.kind === "post") {
      setChecks('[name="categoryIds[]"]', p.categoryIds);
      setChecks('[name="tagIds[]"]', p.tagIds);
      var pin = root.querySelector("[name=pinned]");
      if (pin) pin.checked = !!p.pinned;
    }
    if (typeof ed.renderFormatFields === "function") ed.renderFormatFields();
    var fm = p.formatMeta && typeof p.formatMeta === "object" ? p.formatMeta : {};
    var fmEls = root.querySelectorAll("[data-fm]");
    for (var j = 0; j < fmEls.length; j++) {
      var k = fmEls[j].getAttribute("data-fm");
      if (k in fm && fm[k] != null) fmEls[j].value = String(fm[k]);
    }
    var ctInput = root.querySelector("[data-ctheme-input]");
    if (ctInput) {
      var ctor = ed.constructor || {};
      var ctKey = ctor.CARD_THEME_META_KEY || "bluemix_card_theme";
      var ctVal = ctKey in fm && fm[ctKey] != null ? String(fm[ctKey]) : "";
      ctInput.value = ctVal;
      if (typeof ed.setCardTheme === "function") ed.setCardTheme(ctVal);
    }
    if (Array.isArray(p.metas)) {
      ed.metas = p.metas.map(function (m) { return { key: String((m && m.key) || ""), value: String((m && m.value) || "") }; });
      if (typeof ed.renderMetas === "function") ed.renderMetas();
    }
    if (Array.isArray(p.content)) {
      ed.blocks = p.content;
      if (typeof ed.render === "function") ed.render();
    }
  }

  function showBanner(ed, root, ls, snap, ttlDays) {
    if (root.querySelector(".xob-as-banner")) return;
    injectStyles();
    var bar = document.createElement("div");
    bar.className = "xob-as-banner";
    bar.setAttribute("role", "status");
    var dot = document.createElement("span");
    dot.className = "xob-as-dot";
    var msg = document.createElement("span");
    msg.textContent = "检测到未保存的本地草稿（" + core.formatTime(snap.savedAt) + " 保存于本机浏览器）";
    var sp = document.createElement("span");
    sp.className = "xob-as-sp";
    var restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "adm-btn adm-btn-sm";
    restoreBtn.textContent = "恢复草稿";
    var dropBtn = document.createElement("button");
    dropBtn.type = "button";
    dropBtn.className = "adm-btn adm-btn-ghost adm-btn-sm";
    dropBtn.textContent = "丢弃";
    bar.appendChild(dot);
    bar.appendChild(msg);
    bar.appendChild(sp);
    bar.appendChild(restoreBtn);
    bar.appendChild(dropBtn);
    root.insertBefore(bar, root.firstChild);

    function dismiss() {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }
    function toast(text, kind) {
      if (typeof window.admToast === "function") window.admToast(text, kind);
    }
    restoreBtn.addEventListener("click", function () {
      try {
        applyPayload(ed, snap.payload);
        toast("已恢复本地草稿", "ok");
      } catch (e) {
        toast("恢复失败：" + (e && e.message ? e.message : "未知错误"), "err");
      }
      dismiss();
    });
    dropBtn.addEventListener("click", function () {
      try { ls.removeItem(core.buildKey(ed.kind, ed.entity && ed.entity.id != null ? ed.entity.id : null)); } catch (e) {}
      dismiss();
      toast("已丢弃本地草稿");
    });
    void ttlDays;
  }

  function bind(ed, root, ls, ttlDays) {
    function currentId() {
      return ed.entity && ed.entity.id != null ? ed.entity.id : null;
    }
    function key() {
      return core.buildKey(ed.kind, currentId());
    }

    var origSave = ed.save;
    if (typeof origSave === "function") {
      ed.save = function (status) {
        return origSave.call(ed, status).then(function (res) {
          try { ls.removeItem(key()); } catch (e) {}
          return res;
        });
      };
    }

    function capture() {
      var payload;
      try {
        payload = ed.payload();
      } catch (e) {
        return;
      }
      if (!payload) return;
      if (core.isEmptyPayload(payload)) {
        try { ls.removeItem(key()); } catch (e) {}
        return;
      }
      var text = core.serialize({ v: core.VERSION, kind: ed.kind, id: currentId(), savedAt: Date.now(), payload: payload });
      if (text == null) return;
      try { ls.setItem(key(), text); } catch (e) {}
    }

    var timer = null;
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(capture, DEBOUNCE_MS);
    }
    root.addEventListener("input", schedule);
    root.addEventListener("change", schedule);
    window.addEventListener("pagehide", capture);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") capture();
    });

    var raw = null;
    try { raw = ls.getItem(key()); } catch (e) {}
    var snap = core.deserialize(raw);
    var now = Date.now();
    if (snap) {
      if (core.isExpired(snap, ttlDays, now)) {
        try { ls.removeItem(key()); } catch (e) {}
        snap = null;
      } else {
        var current = null;
        try { current = ed.payload(); } catch (e) {}
        if (current && core.samePayload(current, snap.payload)) {
          try { ls.removeItem(key()); } catch (e) {}
          snap = null;
        }
      }
    }
    if (snap) showBanner(ed, root, ls, snap, ttlDays);

    if (currentId() != null) {
      var newRaw = null;
      try { newRaw = ls.getItem(core.buildKey(ed.kind, null)); } catch (e) {}
      var newSnap = core.deserialize(newRaw);
      if (newSnap) {
        var cur = null;
        try { cur = ed.payload(); } catch (e) {}
        if (cur && core.samePayload(cur, newSnap.payload)) {
          try { ls.removeItem(core.buildKey(ed.kind, null)); } catch (e) {}
        }
      }
    }
  }

  function install() {
    var root = document.querySelector("[data-adm-editor]");
    if (!root || root.__oboextAutosave) return;
    var ls = getStore();
    if (!ls) return;
    root.__oboextAutosave = true;
    var ttlDays = readTtlDays(root);
    core.sweepExpired(ls, ttlDays, Date.now());
    var tries = 0;
    function boot() {
      var ed = window.__admEditor;
      if (!ed || typeof ed.payload !== "function") {
        if (++tries < 100) setTimeout(boot, 50);
        return;
      }
      try {
        bind(ed, root, ls, ttlDays);
      } catch (e) {}
    }
    boot();
  }

  if (typeof document !== "undefined" && typeof document.querySelector === "function") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", install);
    } else {
      install();
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { core: core };
  }
})();
