/**
 * Pjax navigation for oboext themes (skyscraper / default / pseudolinear /
 * codeman / bluemix). Intercepts internal link clicks, fetches the target page
 * and swaps only <main id="sk-main"> so cross-page navigation happens without a
 * full reload; the thick chrome (nav, footer) stays mounted.
 *
 * bluemix choreography is a 1:1 port of themes/bluemix/RouteFrame.tsx:
 *   click → frame.pf-leave (content sinks 1.5em + fades, LEAVE_MS=300)
 *         → body.bmx-nav-loading (nav progress sweep) + .full-loading.show
 *           (5 bouncing bars) while the fetch is in flight (OVERLAY_MIN_MS=450)
 *         → swap innerHTML, frame.pf-enter (content descends from above)
 *         → body.bmx-nav-done then cleared.
 * Other themes now use a brief fade-out → swap → fade-in animation
 * (180ms each way) so cross-page navigation is visibly smooth even when the
 * theme's own entrance keyframe (pl-rise / cm-typein) would otherwise not
 * replay — the root scrolls itself in but the content area still needs a
 * transition cue.
 */
(function () {
  "use strict";
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  let seq = 0;
  let key = location.pathname + location.search;

  const LEAVE_MS = 300;
  const OVERLAY_MIN_MS = 450;
  const INITIAL_MIN_MS = 420;

  let isBluemix = false;
  let frame = null;
  let overlay = null;
  function resolveRefs() {
    if (!isBluemix) isBluemix = !!document.querySelector(".th-bluemix");
    if (!frame) frame = document.querySelector("[data-bmx-frame]");
    if (!overlay) overlay = document.querySelector(".full-loading");
  }
  resolveRefs();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function frameCls(cls) {
    resolveRefs();
    if (!frame) return;
    frame.classList.remove("pf-init", "pf-leave", "pf-enter");
    if (cls) frame.classList.add(cls);
  }
  function overlayShow(on) {
    resolveRefs();
    if (overlay) overlay.classList.toggle("show", !!on);
  }
  function navProgress(state) {
    resolveRefs();
    if (!isBluemix) return;
    document.body.classList.toggle("bmx-nav-loading", state === "start");
    document.body.classList.toggle("bmx-nav-done", state === "done");
  }

  
  
  
  let initialDone = false;
  function initialPaint() {
    if (initialDone) return true;
    resolveRefs();
    if (!isBluemix || !frame) return false;
    initialDone = true;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finish = () => {
      setTimeout(() => {
        overlayShow(false);
        frameCls(reduced ? "" : "pf-enter");
      }, INITIAL_MIN_MS);
    };
    if (reduced || document.readyState === "complete") {
      finish();
    } else {
      window.addEventListener("load", finish, { once: true });
      setTimeout(finish, 1800);
    }
    return true;
  }
  if (!initialPaint()) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initialPaint);
    }
    let tries = 0;
    const iv = setInterval(() => {
      if (initialPaint() || ++tries > 40) clearInterval(iv);
    }, 50);
  }

  function eligible(a) {
    if (!a || !a.getAttribute("href")) return false;
    const href = a.getAttribute("href");
    if (!href.startsWith("/") || href.startsWith("//")) return false;
    if (a.target === "_blank" || a.hasAttribute("download") || a.hasAttribute("data-no-pjax")) return false;
    if (/\.[a-z0-9]+($|[?#])/i.test(href.split("?")[0].split("#")[0])) return false;
    const url = new URL(href, location.href);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) return false;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return false;
    return url;
  }

  async function fetchDoc(want) {
    let res;
    try {
      res = await fetch(want.pathname + want.search, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        const retry = await fetch(want.pathname + want.search, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (retry.ok) res = retry;
      }
    } catch {
      return null;
    }
    const ctype = res.headers.get("content-type") || "";
    if (ctype.indexOf("text/html") < 0) return null;
    if (!res.ok && res.status !== 404) return null;
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const next = doc.getElementById("sk-main");
    if (!next) return null;
    return { doc, next, url: new URL(res.url || want.href) };
  }

  async function go(raw, push) {
    resolveRefs();
    const s = ++seq;
    const want = new URL(raw, location.href);
    const t0 = Date.now();

    if (isBluemix) {
      frameCls("pf-leave");
      navProgress("start");
      await wait(LEAVE_MS);
      if (s !== seq) return;
      overlayShow(true);
    }

    const got = await fetchDoc(want);
    if (s !== seq) return;
    if (!got) {
      if (isBluemix) { overlayShow(false); frameCls("pf-enter"); navProgress("done"); }
      location.href = want.href;
      return;
    }

    if (isBluemix) {
      const elapsed = Date.now() - t0 - LEAVE_MS;
      if (elapsed < OVERLAY_MIN_MS) await wait(OVERLAY_MIN_MS - elapsed);
      if (s !== seq) return;
    }

    const main = document.getElementById("sk-main");
    if (isBluemix) {
      resolveRefs();
      const incoming = got.next.querySelector("[data-bmx-frame]");
      if (frame && incoming) {
        frame.innerHTML = incoming.innerHTML;
      } else {
        main.innerHTML = got.next.innerHTML;
      }
    } else {
      main.style.transition = "opacity 180ms ease";
      main.style.opacity = "0";
      await wait(180);
      if (s !== seq) return;
      main.innerHTML = got.next.innerHTML;
      main.getBoundingClientRect();
      main.style.opacity = "1";
    }
    const t = got.doc.querySelector("title");
    if (t) document.title = t.textContent;
    const final = got.url;
    if (push) {
      history.replaceState({ rv: 1, y: window.scrollY }, "");
      history.pushState({ rv: 1, y: 0 }, "", final.pathname + final.search + final.hash);
    }
    key = final.pathname + final.search;

    if (isBluemix) {
      overlayShow(false);
      frameCls("pf-enter");
      navProgress("done");
      setTimeout(() => navProgress(null), 900);
    }

    document.dispatchEvent(new CustomEvent("rv:nav"));
    if (final.hash) {
      const el = document.getElementById(final.hash.slice(1)) || document.querySelector(final.hash);
      if (el) { el.scrollIntoView(); return; }
    }
    window.scrollTo(0, push ? 0 : ((history.state && history.state.y) || 0));
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (!document.getElementById("sk-main")) return;
    const a = e.target.tagName === "A" ? e.target : e.target.closest && e.target.closest("a");
    const url = eligible(a);
    if (!url) return;
    e.preventDefault();
    go(url.pathname + url.search + url.hash, true);
  });
  window.addEventListener("popstate", () => {
    if (!document.getElementById("sk-main")) { location.reload(); return; }
    if (location.pathname + location.search === key) return;
    go(location.pathname + location.search, false);
  });
})();

(function () {
  "use strict";

  function focusSearch() {
    var el = document.querySelector(".df-search-input");
    if (!el) return;
    el.focus();
    el.select();
  }

  function isTyping(t) {
    if (!t) return false;
    var tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    var box = document.querySelector(".df-search-box");
    if (!box) return;
    e.preventDefault();
    focusSearch();
  });

  document.addEventListener("focusin", function (e) {
    if (e.target && e.target.classList && e.target.classList.contains("df-search-input")) {
      var box = e.target.closest(".df-search-box");
      if (box) box.classList.add("is-focused");
    }
  });
  document.addEventListener("focusout", function (e) {
    if (e.target && e.target.classList && e.target.classList.contains("df-search-input")) {
      var box = e.target.closest(".df-search-box");
      if (box) box.classList.remove("is-focused");
    }
  });

  function staggerCards() {
    var cards = document.querySelectorAll(".df-aside .df-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.transitionDelay = 60 + i * 70 + "ms";
    }
  }
  staggerCards();
  document.addEventListener("rv:nav", staggerCards);

  function closeDrawer() {
    var open = document.querySelector("details.dfm-menu[open]");
    if (open) open.removeAttribute("open");
  }
  document.addEventListener("click", function (e) {
    var link = e.target && e.target.closest ? e.target.closest(".dfm-list a") : null;
    if (link) closeDrawer();
  });
  document.addEventListener("rv:nav", closeDrawer);

  function navCurrentPath() {
    var norm = function (s) {
      return s.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
    };
    var cur = norm(location.pathname);
    var lists = document.querySelectorAll(
      ".df-menu-list, .dfm-list, .df-cat-tree, .df-side-list"
    );
    for (var i = 0; i < lists.length; i++) {
      var links = lists[i].querySelectorAll("a[href]");
      for (var j = 0; j < links.length; j++) {
        var a = links[j];
        if (a.getAttribute("href") === "#" || a.hasAttribute("data-no-nav")) continue;
        var href = norm(a.getAttribute("href") || "");
        if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        var isCur =
          cur === "/"
            ? href === "/"
            : href !== "/" && (cur === href || cur.indexOf(href + "/") === 0);
        a.classList.toggle("is-current", isCur);
        if (isCur) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      }
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", navCurrentPath);
  } else {
    navCurrentPath();
  }
  document.addEventListener("rv:nav", navCurrentPath);

  function rovingNav() {
    var bars = document.querySelectorAll(".df-menu-list");
    for (var b = 0; b < bars.length; b++) {
      var bar = bars[b];
      var links = bar.querySelectorAll(".df-menu-link");
      if (!links.length) continue;
      var cur = -1;
      for (var i = 0; i < links.length; i++) {
        if (links[i].classList.contains("is-current")) { cur = i; break; }
      }
      var setTab = function (idx) {
        for (var j = 0; j < links.length; j++) links[j].tabIndex = j === idx ? 0 : -1;
      };
      setTab(cur >= 0 ? cur : 0);

      if (bar.dataset.rvRoving === "1") continue;
      bar.dataset.rvRoving = "1";
      bar.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
        var items = this.querySelectorAll(".df-menu-link");
        var idx = -1;
        for (var k = 0; k < items.length; k++) if (items[k] === document.activeElement) { idx = k; break; }
        if (idx < 0) return;
        e.preventDefault();
        var next = idx;
        if (e.key === "ArrowRight") next = (idx + 1) % items.length;
        else if (e.key === "ArrowLeft") next = (idx - 1 + items.length) % items.length;
        else if (e.key === "Home") next = 0;
        else next = items.length - 1;
        items[next].focus();
        for (var t = 0; t < items.length; t++) items[t].tabIndex = t === next ? 0 : -1;
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", rovingNav);
  else rovingNav();
  document.addEventListener("rv:nav", rovingNav);

  function shareLabel(btn, text) {
    var l = btn.querySelector("[data-share-label]");
    if (!l) return;
    if (btn.__t0 === undefined) btn.__t0 = l.textContent;
    l.textContent = text;
    clearTimeout(btn.__t);
    btn.__t = setTimeout(function () { l.textContent = btn.__t0; }, 1600);
  }
  function legacyCopy(url) {
    try {
      var t = document.createElement("textarea");
      t.value = url;
      t.setAttribute("readonly", "");
      t.style.position = "fixed";
      t.style.top = "-1000px";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      t.setSelectionRange(0, url.length);
      var ok = document.execCommand("copy");
      document.body.removeChild(t);
      if (ok) return Promise.resolve("已复制");
    } catch (e) {}
    return Promise.reject();
  }
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-share-copy]") : null;
    if (!btn) return;
    e.preventDefault();
    var url = location.href;
    var p = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(url).then(function () { return "已复制"; })
      : Promise.reject();
    p.catch(function () { return legacyCopy(url); })
      .catch(function () {
        return navigator.share
          ? navigator.share({ url: url }).then(function () { return "已分享"; })
          : Promise.reject();
      })
      .then(function (t) { shareLabel(btn, t); }, function () { shareLabel(btn, "复制失败"); });
  });

  function refreshViews() {
    var slots = document.querySelectorAll("[data-views-post]");
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var id = slot.getAttribute("data-views-post");
      var out = slot.querySelector("[data-views-count]");
      if (!id || !out) continue;
      fetch("/api/posts/" + encodeURIComponent(id) + "/views", {
        headers: { accept: "application/json" },
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && typeof d.views === "number") out.textContent = d.views;
        })
        .catch(function () {});
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refreshViews);
  else refreshViews();
  document.addEventListener("rv:nav", refreshViews);

  var SUGGEST_MIN = 2;
  var SUGGEST_DELAY = 180;
  var SUGGEST_MAX = 8;

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function markMatch(title, q) {
    var t = escHtml(title);
    if (!q) return t;
    var lower = t.toLowerCase();
    var needle = q.toLowerCase();
    var out = "";
    var from = 0;
    for (;;) {
      var at = lower.indexOf(needle, from);
      if (at < 0) break;
      out += t.slice(from, at) + '<span class="df-suggest-mark">' + t.slice(at, at + needle.length) + "</span>";
      from = at + needle.length;
    }
    return out + t.slice(from);
  }

  function panelOf(input) {
    var id = input.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  }

  function closeSuggest(input) {
    var p = panelOf(input);
    if (p) {
      p.hidden = true;
      p.innerHTML = "";
    }
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (input.__df) input.__df.active = -1;
  }

  function renderSuggest(input, q, data) {
    var panel = panelOf(input);
    if (!panel) return;
    var items = (data && data.items) || [];
    if (!items.length) {
      panel.innerHTML = '<div class="df-suggest-empty">没有匹配「' + escHtml(q) + '」的文章</div>';
    } else {
      var html = items
        .slice(0, SUGGEST_MAX)
        .map(function (it, i) {
          var thumb = it.thumbnail
            ? '<img class="df-suggest-thumb" src="' + escHtml(it.thumbnail) + '" alt="" loading="lazy">'
            : "";
          return '<a class="df-suggest-item" id="df-suggest-opt-' + i + '" role="option"' +
            ' href="' + escHtml(it.url) + '">' + thumb +
            '<span class="df-suggest-title">' + markMatch(it.title, q) + "</span></a>";
        })
        .join("");
      var foot = (data && typeof data.total === "number" && data.total > items.length)
        ? '<div class="df-suggest-foot">共 ' + data.total + " 篇，按 Enter 查看全部</div>"
        : "";
      panel.innerHTML = '<div role="listbox">' + html + "</div>" + foot;
    }
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (input.__df) input.__df.active = -1;
  }

  function querySuggest(input) {
    var st = input.__df;
    var q = input.value.trim();
    if (q.length < SUGGEST_MIN) {
      closeSuggest(input);
      return;
    }
    var seq = ++st.seq;
    fetch("/api/search-suggest?q=" + encodeURIComponent(q), {
      headers: { accept: "application/json" },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (seq !== st.seq) return;
        renderSuggest(input, q, d);
      })
      .catch(function () {
        if (seq === st.seq) closeSuggest(input);
      });
  }

  function activeItem(input) {
    var panel = panelOf(input);
    if (!panel) return null;
    var all = panel.querySelectorAll(".df-suggest-item");
    return input.__df && input.__df.active >= 0 ? all[input.__df.active] || null : null;
  }

  function moveActive(input, delta) {
    var panel = panelOf(input);
    if (!panel) return;
    var all = panel.querySelectorAll(".df-suggest-item");
    if (!all.length) return;
    var st = input.__df;
    var next = st.active + delta;
    if (next >= all.length) next = delta > 0 ? 0 : all.length - 1;
    if (next < 0) next = delta < 0 ? all.length - 1 : 0;
    if (st.active >= 0 && all[st.active]) all[st.active].classList.remove("is-active");
    all[next].classList.add("is-active");
    st.active = next;
    input.setAttribute("aria-activedescendant", all[next].id);
    all[next].scrollIntoView({ block: "nearest" });
  }

  function initSuggest(input) {
    if (!input || input.__df) return;
    input.__df = { seq: 0, timer: 0, active: -1 };
    input.addEventListener("input", function () {
      var st = input.__df;
      clearTimeout(st.timer);
      var q = input.value.trim();
      if (q.length < SUGGEST_MIN) {
        st.seq++;
        closeSuggest(input);
        return;
      }
      st.timer = setTimeout(function () { querySuggest(input); }, SUGGEST_DELAY);
    });
    input.addEventListener("keydown", function (e) {
      var st = input.__df;
      var open = panelOf(input) && !panelOf(input).hidden;
      if (e.key === "Escape") {
        if (open) {
          e.preventDefault();
          closeSuggest(input);
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!open) return;
        e.preventDefault();
        moveActive(input, e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter") {
        var hit = activeItem(input);
        if (hit) {
          e.preventDefault();
          hit.click();
        }
        // Otherwise the form submits normally, which the pjax submit handler
        // below turns into a client-side navigation.
      }
    });
  }

  function initAllSuggests() {
    var inputs = document.querySelectorAll(".df-search-input[aria-controls]");
    for (var i = 0; i < inputs.length; i++) initSuggest(inputs[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initAllSuggests);
  else initAllSuggests();
  document.addEventListener("rv:nav", initAllSuggests);

  document.addEventListener("click", function (e) {
    var inside = e.target && e.target.closest
      ? e.target.closest(".df-search-box")
      : null;
    if (inside) return;
    var inputs = document.querySelectorAll(".df-search-input[aria-controls]");
    for (var i = 0; i < inputs.length; i++) closeSuggest(inputs[i]);
  });

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.classList || !form.classList.contains("df-search-form")) return;
    if (!document.getElementById("sk-main")) return;
    var data = new FormData(form);
    var q = String(data.get("q") || "").trim();
    if (!q) return;
    e.preventDefault();
    var inputs = document.querySelectorAll(".df-search-input[aria-controls]");
    for (var i = 0; i < inputs.length; i++) closeSuggest(inputs[i]);
    var href = "/search?q=" + encodeURIComponent(q);
    var a = document.createElement("a");
    a.href = href;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
})();
