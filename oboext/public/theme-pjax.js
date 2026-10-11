/**
 * Pjax navigation for non-skyscraper oboext themes (default / pseudolinear /
 * codeman / bluemix). Mirrors the original RouteFrame: intercept internal
 * link clicks, fetch the target page, and swap only the #sk-main container so
 * cross-page navigation happens without a full reload. Thick chrome (head nav,
 * footer) stays mounted.
 *
 * Each theme's route container is <main id="sk-main">; the theme's root class
 * (.th-pseudo / .cm-crt / .th-bluemix / .theme-root) scrolls itself into view
 * after a swap so the entrance animation (pl-rise / cm-typein / pf-enter)
 * replays the way a hard reload would.
 */
(function () {
  "use strict";
  if (!document.getElementById("sk-main")) return;

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  let seq = 0;
  let key = location.pathname + location.search;

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

  async function go(raw, push) {
    const s = ++seq;
    const want = new URL(raw, location.href);
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
      if (s === seq) location.href = want.href;
      return;
    }
    if (s !== seq) return;
    if (!res.ok || (res.headers.get("content-type") || "").indexOf("text/html") < 0) {
      location.href = want.href;
      return;
    }
    const html = await res.text();
    if (s !== seq) return;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const next = doc.getElementById("sk-main");
    if (!next) { location.href = res.url || want.href; return; }
    const main = document.getElementById("sk-main");
    main.innerHTML = next.innerHTML;
    const t = doc.querySelector("title");
    if (t) document.title = t.textContent;
    const final = new URL(res.url || want.href);
    if (push) {
      history.replaceState({ rv: 1, y: window.scrollY }, "");
      history.pushState({ rv: 1, y: 0 }, "", final.pathname + final.search + final.hash);
    }
    key = final.pathname + final.search;
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