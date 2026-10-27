/*
 * Reading mode — post-page reading comfort layer.
 * Zero dependencies, self-contained style injection (same pattern as autosave.js):
 * the pure core plus the locale message tables are exported via module.exports
 * so node unit tests can require this exact file; the browser install is
 * guarded by `typeof document`. UI strings resolve through M(el, key):
 * the article's data-reading-locale attribute first, then <html lang>.
 *
 * Scope: only activates on pages carrying <article id="post-body"> (single post
 * view). State persists in localStorage; pjax navigations re-install via rv:nav
 * and rebuild the chrome when the locale changed (chromeLocale guard).
 */
(function (root, factory) {
  var api = factory();
  var core = api.core;
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;
  var ready = function (fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  };
  ready(function () {
    install(core, api);
  });

  function install(core, api) {
    var M = api.M;
    var localeOf = api.localeOf;
    var chromeLocale = "";
    var KEY = "oboext:reading-mode:v1";
    var FAB_ID = "reading-mode-fab";
    var BAR_ID = "reading-mode-progress";
    var STYLE_ID = "reading-mode-style";
    var SIZE_MIN = 14;
    var SIZE_MAX = 24;
    var LH_MIN = 1.5;
    var LH_MAX = 2.2;
    var SANS = 'system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
    var SERIF = 'Georgia,"Times New Roman","Songti SC","Noto Serif SC","SimSun",serif';
    var state = core.readState(function () {
      try {
        return localStorage.getItem(KEY);
      } catch {
        return null;
      }
    });

    function article() {
      return document.getElementById("post-body");
    }

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var css = [
        "#" + BAR_ID + "{position:fixed;top:0;left:0;height:3px;width:0;z-index:9998;pointer-events:none;",
        "background:linear-gradient(90deg,var(--rm-accent,#4f7cff),var(--rm-accent2,#9a6bff));",
        "transition:width .08s linear;opacity:0;}",
        "#" + BAR_ID + ".rm-on{opacity:1;}",
        "#" + FAB_ID + "{position:fixed;right:18px;bottom:78px;width:44px;height:44px;border:1px solid rgba(127,127,127,.25);",
        "border-radius:50%;background:var(--rm-panel-bg,#fff);color:var(--rm-panel-fg,#333);cursor:pointer;z-index:9999;",
        "display:flex;align-items:center;justify-content:center;box-shadow:0 4px 18px rgba(0,0,0,.14);padding:0;}",
        "#" + FAB_ID + ":hover{border-color:var(--rm-accent,#4f7cff);color:var(--rm-accent,#4f7cff);}",
        "#" + FAB_ID + " svg{width:20px;height:20px;}",
        ".rm-panel{position:fixed;right:18px;bottom:132px;width:264px;max-width:calc(100vw - 36px);z-index:9999;",
        "background:var(--rm-panel-bg,#fff);color:var(--rm-panel-fg,#333);border:1px solid rgba(127,127,127,.22);",
        "border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.18);padding:14px 16px;font-size:14px;",
        "display:none;box-sizing:border-box;}",
        ".rm-panel.rm-open{display:block;}",
        ".rm-panel h4{margin:0 0 10px;font-size:14px;font-weight:600;}",
        ".rm-row{margin-bottom:12px;}",
        ".rm-row>label{display:block;margin-bottom:6px;font-size:12px;opacity:.72;}",
        ".rm-seg{display:flex;gap:6px;}",
        ".rm-seg button{flex:1;padding:6px 0;border:1px solid rgba(127,127,127,.3);border-radius:8px;",
        "background:transparent;color:inherit;font-size:13px;cursor:pointer;}",
        ".rm-seg button.rm-active{border-color:var(--rm-accent,#4f7cff);color:var(--rm-accent,#4f7cff);",
        "background:color-mix(in srgb,var(--rm-accent,#4f7cff) 10%,transparent);}",
        ".rm-stepper{display:flex;align-items:center;gap:8px;}",
        ".rm-stepper button{width:32px;height:32px;border:1px solid rgba(127,127,127,.3);border-radius:8px;",
        "background:transparent;color:inherit;font-size:15px;cursor:pointer;line-height:1;}",
        ".rm-stepper .rm-val{min-width:52px;text-align:center;font-variant-numeric:tabular-nums;}",
        ".rm-actions{display:flex;gap:8px;margin-top:4px;}",
        ".rm-actions button{flex:1;padding:7px 0;border-radius:8px;font-size:13px;cursor:pointer;",
        "border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;}",
        ".rm-actions .rm-primary{border-color:var(--rm-accent,#4f7cff);background:var(--rm-accent,#4f7cff);color:#fff;}",
        '[data-color-scheme="dark"] .rm-panel,[data-color-scheme="dark"] #' + FAB_ID + "{--rm-panel-bg:#23262d;--rm-panel-fg:#e8eaed;}",
        "article[data-reading-mode] .post-content{font-size:var(--rm-fs);line-height:var(--rm-lh);font-family:var(--rm-ff);}",
        'article[data-reading-mode="narrow"] .post-content{max-width:680px;margin-left:auto;margin-right:auto;}',
        'article[data-reading-mode="wide"] .post-content{max-width:1020px;margin-left:auto;margin-right:auto;}',
        "article[data-reading-font=serif] .post-content{--rm-ff:" + SERIF + ";}",
        "article[data-reading-font=sans] .post-content{--rm-ff:" + SANS + ";}",
        "@media (prefers-reduced-motion:reduce){#" + BAR_ID + "{transition:none;}}",
        "@media (max-width:640px){.rm-panel{right:12px;left:12px;width:auto;}#" + FAB_ID + "{right:12px;bottom:12px;}}",
      ].join("");
      var st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = css;
      document.head.appendChild(st);
    }

    var fab = null;
    var panel = null;
    var bar = null;
    var rafId = 0;

    function apply() {
      var a = article();
      if (!a) return;
      if (state.on) {
        a.setAttribute("data-reading-mode", state.width);
        a.setAttribute("data-reading-font", state.font);
        a.style.setProperty("--rm-fs", state.size + "px");
        a.style.setProperty("--rm-lh", String(state.lh));
      } else {
        a.removeAttribute("data-reading-mode");
        a.removeAttribute("data-reading-font");
        a.style.removeProperty("--rm-fs");
        a.style.removeProperty("--rm-lh");
      }
      if (bar) bar.classList.toggle("rm-on", state.on);
      if (fab) fab.setAttribute("aria-pressed", state.on ? "true" : "false");
      if (panel) {
        panel.querySelectorAll("[data-rm-seg] button").forEach(function (b) {
          var group = b.getAttribute("data-rm-seg");
          b.classList.toggle("rm-active", String(state[group]) === b.getAttribute("data-rm-value"));
        });
        var val = panel.querySelector(".rm-val");
        if (val) {
          var focused = document.activeElement === val;
          if (!focused) val.textContent = state.size + "px / " + state.lh.toFixed(1);
        }
      }
      persist();
    }

    function persist() {
      try {
        localStorage.setItem(KEY, core.serializeState(state));
      } catch {}
    }

    function ensureChrome() {
      var a = article();
      if (fab) {
        if (chromeLocale && chromeLocale !== localeOf(a)) {
          fab.remove();
          panel.remove();
          bar.remove();
          fab = panel = bar = null;
        } else {
          return;
        }
      }
      injectStyle();
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", M(a, "progress"));
      document.body.appendChild(bar);

      fab = document.createElement("button");
      fab.id = FAB_ID;
      fab.type = "button";
      fab.title = M(a, "exit_hint");
      fab.setAttribute("aria-label", M(a, "title"));
      fab.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
      document.body.appendChild(fab);

      panel = document.createElement("div");
      panel.className = "rm-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", M(a, "settings"));
      panel.innerHTML =
        '<h4>' + M(a, "title") + '</h4>' +
        '<div class="rm-row"><label>' + M(a, "width") + '</label><div class="rm-seg" data-rm-seg="width">' +
        '<button type="button" data-rm-seg="width" data-rm-value="default">' + M(a, "width_default") + '</button>' +
        '<button type="button" data-rm-seg="width" data-rm-value="narrow">' + M(a, "width_narrow") + '</button>' +
        '<button type="button" data-rm-seg="width" data-rm-value="wide">' + M(a, "width_wide") + '</button></div></div>' +
        '<div class="rm-row"><label>' + M(a, "font") + '</label><div class="rm-seg" data-rm-seg="font">' +
        '<button type="button" data-rm-seg="font" data-rm-value="sans">' + M(a, "font_sans") + '</button>' +
        '<button type="button" data-rm-seg="font" data-rm-value="serif">' + M(a, "font_serif") + '</button></div></div>' +
        '<div class="rm-row"><label>' + M(a, "size_lh") + '</label><div class="rm-stepper">' +
        '<button type="button" data-rm-step="size" data-rm-dir="-1" aria-label="' + M(a, "size_dec") + '">A&#8722;</button>' +
        '<span class="rm-val"></span>' +
        '<button type="button" data-rm-step="size" data-rm-dir="1" aria-label="' + M(a, "size_inc") + '">A+</button>' +
        '<button type="button" data-rm-step="lh" data-rm-dir="-1" aria-label="' + M(a, "lh_dec") + '">&#8212;</button>' +
        '<button type="button" data-rm-step="lh" data-rm-dir="1" aria-label="' + M(a, "lh_inc") + '">&#8222;</button></div></div>' +
        '<div class="rm-actions">' +
        '<button type="button" class="rm-primary" data-rm-act="toggle"></button>' +
        '<button type="button" data-rm-act="reset">' + M(a, "reset") + '</button></div>';
      document.body.appendChild(panel);
      chromeLocale = localeOf(a);

      fab.addEventListener("click", function () {
        panel.classList.toggle("rm-open");
      });
      panel.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || !t.getAttribute) return;
        var seg = t.getAttribute("data-rm-seg");
        if (seg) {
          state[seg] = t.getAttribute("data-rm-value");
          apply();
          return;
        }
        var step = t.getAttribute("data-rm-step");
        if (step) {
          var dir = Number(t.getAttribute("data-rm-dir")) || 0;
          if (step === "size") state.size = core.clampNumber(state.size + dir, SIZE_MIN, SIZE_MAX);
          else state.lh = core.clampNumber(state.lh + dir * 0.1, LH_MIN, LH_MAX);
          apply();
          return;
        }
        var act = t.getAttribute("data-rm-act");
        if (act === "toggle") {
          state.on = !state.on;
          apply();
          syncToggleLabel();
          if (state.on) panel.classList.remove("rm-open");
        } else if (act === "reset") {
          state = core.readState(null);
          apply();
          syncToggleLabel();
        }
      });
      panel.addEventListener("keydown", function (e) {
        if (e.key === "Escape") panel.classList.remove("rm-open");
      });
      syncToggleLabel();
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.on && panel && !panel.classList.contains("rm-open")) {
        state.on = false;
        apply();
        syncToggleLabel();
      }
    });
    document.addEventListener("click", function (e) {
      if (!panel || !panel.classList.contains("rm-open")) return;
      if (panel.contains(e.target) || (fab && fab.contains(e.target))) return;
      panel.classList.remove("rm-open");
    });
    window.addEventListener("resize", scheduleProgress, { passive: true });
    window.addEventListener("scroll", scheduleProgress, { passive: true });

    function syncToggleLabel() {
      if (!panel) return;
      var btn = panel.querySelector('[data-rm-act="toggle"]');
      if (btn) btn.textContent = state.on ? M(article(), "exit") : M(article(), "enter");
    }

    function paintProgress() {
      rafId = 0;
      if (!bar || !state.on) return;
      var de = document.documentElement;
      var scrollable = de.scrollHeight - window.innerHeight;
      var pct = core.progressPercent(window.scrollY || de.scrollTop || 0, scrollable);
      bar.style.width = pct + "%";
      bar.setAttribute("aria-valuenow", String(pct));
    }

    function scheduleProgress() {
      if (rafId || !state.on) return;
      rafId = requestAnimationFrame(paintProgress);
    }

    function mount() {
      if (!article()) {
        if (fab) {
          fab.remove();
          panel.remove();
          bar.remove();
          fab = panel = bar = null;
        }
        return;
      }
      ensureChrome();
      apply();
      scheduleProgress();
    }

    document.addEventListener("rv:nav", mount);
    window.addEventListener("pagehide", function () {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    });
    mount();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var MSGS = {
    zh: {
      progress: "阅读进度",
      title: "阅读模式",
      exit_hint: "阅读模式 (Esc 退出)",
      settings: "阅读模式设置",
      width: "栏宽",
      width_default: "默认",
      width_narrow: "窄栏",
      width_wide: "宽栏",
      font: "字体",
      font_sans: "无衬线",
      font_serif: "衬线",
      size_lh: "字号与行距",
      size_dec: "减小字号",
      size_inc: "增大字号",
      lh_dec: "减小行距",
      lh_inc: "增大行距",
      reset: "恢复默认",
      enter: "开启阅读模式",
      exit: "退出阅读模式",
    },
    en: {
      progress: "Reading progress",
      title: "Reading mode",
      exit_hint: "Reading mode (Esc to exit)",
      settings: "Reading mode settings",
      width: "Column width",
      width_default: "Default",
      width_narrow: "Narrow",
      width_wide: "Wide",
      font: "Font",
      font_sans: "Sans-serif",
      font_serif: "Serif",
      size_lh: "Size & line height",
      size_dec: "Decrease font size",
      size_inc: "Increase font size",
      lh_dec: "Decrease line height",
      lh_inc: "Increase line height",
      reset: "Reset to defaults",
      enter: "Enter reading mode",
      exit: "Exit reading mode",
    },
  };
  function localeOf(e) {
    var a = e && e.getAttribute ? e.getAttribute("data-reading-locale") : "";
    if (a !== "en" && a !== "zh-CN") {
      var d = typeof document !== "undefined" && document.documentElement
        ? document.documentElement.getAttribute("lang")
        : "";
      a = d === "en" ? "en" : "zh-CN";
    }
    return a;
  }
  function M(e, t) {
    return (localeOf(e) === "en" ? MSGS.en : MSGS.zh)[t];
  }
  var WIDTHS = ["default", "narrow", "wide"];
  var FONTS = ["sans", "serif"];
  function clampNumber(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }
  function defaultState() {
    return { on: false, width: "default", font: "sans", size: 17, lh: 1.75 };
  }
  function readState(load) {
    var s = defaultState();
    if (typeof load !== "function") return s;
    var raw;
    try {
      raw = load();
    } catch {
      return s;
    }
    if (typeof raw !== "string" || !raw) return s;
    var obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return s;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return s;
    s.on = obj.on === true;
    if (WIDTHS.indexOf(obj.width) !== -1) s.width = obj.width;
    if (FONTS.indexOf(obj.font) !== -1) s.font = obj.font;
    s.size = Math.round(clampNumber(obj.size, 14, 24));
    s.lh = Math.round(clampNumber(obj.lh, 1.5, 2.2) * 10) / 10;
    return s;
  }
  function serializeState(s) {
    var d = defaultState();
    var out = {
      on: s && s.on === true,
      width: WIDTHS.indexOf(s && s.width) !== -1 ? s.width : d.width,
      font: FONTS.indexOf(s && s.font) !== -1 ? s.font : d.font,
      size: Math.round(clampNumber(s && s.size, 14, 24)),
      lh: Math.round(clampNumber(s && s.lh, 1.5, 2.2) * 10) / 10,
    };
    return JSON.stringify(out);
  }
  function progressPercent(scrollTop, scrollable) {
    var n = Number(scrollTop);
    var s = Number(scrollable);
    if (!isFinite(n) || n < 0) n = 0;
    if (!isFinite(s) || s <= 8) return 100;
    var pct = Math.round((n / s) * 100);
    return Math.min(100, Math.max(0, pct));
  }
  return {
    core: {
      clampNumber: clampNumber,
      defaultState: defaultState,
      readState: readState,
      serializeState: serializeState,
      progressPercent: progressPercent,
      WIDTHS: WIDTHS,
      FONTS: FONTS,
    },
    MSGS: MSGS,
    M: M,
    localeOf: localeOf,
  };
});
