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
 * Other themes keep the previous simple swap (their own entrance keyframe —
 * pl-rise / cm-typein — still replays because the root scrolls itself in).
 */
(function () {
  "use strict";
  if (!document.getElementById("sk-main")) return;

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
    if (initialDone) return;
    resolveRefs();
    if (!isBluemix || !frame) return false;
    initialDone = true;
    requestAnimationFrame(() => {
      setTimeout(() => frameCls("pf-enter"), INITIAL_MIN_MS);
    });
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
    if (url.pathname === location.pathname && url.search === location.search) return false;
    return url;
  }

  async function fetchDoc(want) {
    let res;
    try {
      res = await fetch(want.pathname + want.search, { credentials: "same-origin" });
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
    if (!res.ok || (res.headers.get("content-type") || "").indexOf("text/html") < 0) return null;
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
    main.innerHTML = got.next.innerHTML;
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
