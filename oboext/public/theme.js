/**
 * skyscraper theme interactions, vanilla JS — loaded by public pages only.
 *
 * Migrated out of the rosezm components on 0.2.0: routes ship zero framework
 * JS (buffered SSR), so chrome interactions, the cardFlip carousel, share bar
 * and scroll-reveal live here as one delegated boot, mirroring the original
 * components' DOM contracts.
 */
(function () {
  "use strict";

  function boot() {
    const root = document.documentElement;
    const wrapper = document.querySelector(".th-skyscraper");
    if (!wrapper) return;
    const nav = document.querySelector(".top-nav");
    const column = document.querySelector(".sidebar-column");
    const toolbox = nav ? nav.querySelector(".toolbox") : null;
    const loginMain = nav ? nav.querySelector(".login-main") : null;
    const main = document.getElementById("sk-main");
    const sidebarBtn = document.querySelector(".sidebar-btn");

    let disappearTimer = null;

    const isHome = () => location.pathname === "/";
    const syncNav = () => {
      if (!nav) return;
      const scrolled = window.scrollY > 8;
      nav.classList.toggle("is-scrolled", scrolled);
      nav.classList.toggle("always-stay", !isHome() || scrolled);
    };
    const syncDark = () => {
      const dark = root.getAttribute("data-color-scheme") === "dark";
      document.querySelectorAll(".night-day").forEach((i) => i.classList.toggle("is-night", dark));
    };
    syncNav();
    syncDark();
    window.addEventListener("scroll", syncNav, { passive: true });

    let sidebarOpen = false;
    const closeSidebar = () => {
      if (!sidebarOpen) return;
      sidebarOpen = false;
      if (sidebarBtn) sidebarBtn.classList.remove("is-on");
      if (wrapper) wrapper.classList.remove("sidebar-rotated");
      if (column) column.classList.remove("mobile-show");
      if (main) {
        main.classList.add("is-disappearing");
        clearTimeout(disappearTimer);
        disappearTimer = setTimeout(() => main.classList.remove("shade", "is-disappearing"), 520);
      }
    };
    const openSidebar = () => {
      sidebarOpen = true;
      if (sidebarBtn) sidebarBtn.classList.add("is-on");
      if (wrapper) wrapper.classList.add("sidebar-rotated");
      if (column) column.classList.add("mobile-show");
      if (main) {
        main.classList.add("shade", "before-showing");
        requestAnimationFrame(() => main.classList.remove("before-showing"));
      }
    };
    const toggleSidebar = () => (sidebarOpen ? closeSidebar() : openSidebar());
    const toggleToolbox = () => { if (toolbox) toolbox.classList.toggle("mobile-show"); };
    const toggleLogin = () => { if (loginMain) loginMain.classList.toggle("mobile-show"); };
    const toggleDark = () => {
      const next = root.getAttribute("data-color-scheme") !== "dark";
      root.setAttribute("data-color-scheme", next ? "dark" : "light");
      if (wrapper) wrapper.setAttribute("data-color-scheme", next ? "dark" : "light");
      try { localStorage.setItem("skyscraper-color-scheme", next ? "dark" : "light"); } catch (e) {}
      syncDark();
    };

    const onClick = (e) => {
      const hit = (sel) => e.target.closest && e.target.closest(sel);
      if (hit(".sidebar-btn")) { e.preventDefault(); toggleSidebar(); return; }
      if (sidebarOpen && main && hit("#sk-main")) { e.preventDefault(); closeSidebar(); return; }
      if (hit(".toolbox-btn") || hit(".return-btn")) { e.preventDefault(); toggleToolbox(); return; }
      if (hit(".vcard.cursor-hand")) { e.preventDefault(); toggleLogin(); return; }
      if (hit(".mobile-button.show-on-desktop")) { e.preventDefault(); toggleDark(); }
    };
    const onKey = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const b = e.target.closest && e.target.closest("[role='button']");
      if (b) { e.preventDefault(); b.click(); }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);

    const isActiveUrl = (url) =>
      !!url && (url === location.pathname ||
        (url !== "/" && location.pathname.indexOf(url) === 0));
    const syncMenu = () => {
      const menuRoot = document.querySelector("#menu-main");
      if (!menuRoot) return;
      menuRoot.querySelectorAll("li.menu-item").forEach((li) => {
        const a = li.querySelector(":scope > a");
        const on = isActiveUrl(a ? a.getAttribute("href") : "");
        li.classList.toggle("is-active", on);
        li.classList.toggle("current-menu-item", on);
      });
    };
    syncMenu();
    document.addEventListener("click", (e) => {
      const a = e.target.closest &&
        e.target.closest("#menu-main li.menu-item-has-children > a");
      if (!a) return;
      e.preventDefault();
      a.parentElement.classList.toggle("open");
    });
    document.addEventListener("rv:nav", () => {
      syncMenu();
      if (sidebarOpen) closeSidebar();
      if (toolbox) toolbox.classList.remove("mobile-show");
      if (loginMain) loginMain.classList.remove("mobile-show");
      syncNav();
    });

    const TIPS = ["生成海报", "分享到微博", "分享到QQ", "分享到QQ空间", "点赞"];
    const readLiked = () => {
      try {
        const rawLiked = JSON.parse(localStorage.getItem("liked") || "[]");
        return Array.isArray(rawLiked) ? rawLiked.filter((n) => typeof n === "number") : [];
      } catch (e) {
        return [];
      }
    };
    let tipEl = null;
    const hideTip = () => {
      if (tipEl) { tipEl.remove(); tipEl = null; }
    };
    const showTip = (btn, text) => {
      hideTip();
      tipEl = document.createElement("div");
      tipEl.className = "pf-popover tooltip";
      tipEl.setAttribute("data-popper-placement", "top");
      tipEl.style.position = "fixed";
      tipEl.textContent = text;
      const arrow = document.createElement("div");
      arrow.className = "arrow";
      arrow.setAttribute("data-popper-arrow", "");
      arrow.style.left = "50%";
      arrow.style.transform = "translateX(-50%)";
      tipEl.appendChild(arrow);
      document.body.appendChild(tipEl);
      const r = btn.getBoundingClientRect();
      const t = tipEl.getBoundingClientRect();
      tipEl.style.left = Math.max(8, r.left + r.width / 2 - t.width / 2) + "px";
      tipEl.style.top = r.top - t.height - 10 + "px";
    };
    const pushToast = (type, text) => {
      let layer = document.querySelector(".pf-messages");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "pf-messages";
        document.body.appendChild(layer);
      }
      const el = document.createElement("div");
      el.className = "message " + type + " pf-message-enter-from pf-message-enter-active";
      const ICONS = {
        info: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
        success: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        warning: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
      };
      el.innerHTML = '<div class="icon">' + (ICONS[type] || "") + "</div><div class=\"content\"></div>";
      el.querySelector(".content").textContent = text;
      layer.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("pf-message-enter-from")));
      const timer = setTimeout(() => {
        el.classList.add("pf-message-leave-active", "pf-message-leave-to");
        setTimeout(() => el.remove(), 750);
      }, 2200);
      return () => { clearTimeout(timer); el.remove(); };
    };
    const openShare = (kind, bar) => {
      const h1 = document.querySelector("#post-body h1");
      const title = h1 ? h1.textContent : document.title;
      const t = encodeURIComponent(title);
      const u = encodeURIComponent(location.href);
      const thumb = bar.getAttribute("data-thumb") || "";
      const pics = /^https?:\/\//i.test(thumb) || thumb.indexOf("//") === 0 ? thumb : "";
      const summary = encodeURIComponent(bar.getAttribute("data-excerpt") || title);
      const url =
        kind === 1
          ? "http://service.weibo.com/share/share.php?title=" + t + "&url=" + u + "&searchPic=true"
          : kind === 2
            ? "http://connect.qq.com/widget/shareqq/index.html?url=" + u + "&sharesource=qzone&title=" + t + "&pics=" + pics + "&summary=" + summary
            : "https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url=" + u + "&sharesource=qzone&title=" + t + "&pics=" + pics + "&summary=" + summary;
      window.open(url, "_blank", "scrollbars=no,width=800,height=600,status=no,resizable=yes");
    };
    const likedSet = new Set(readLiked());
    document.querySelectorAll(".share-modal").forEach((bar) => {
      const id = Number(bar.getAttribute("data-post-id"));
      if (!likedSet.has(id)) return;
      const btns = bar.querySelectorAll("button");
      const hb = btns[4];
      if (!hb) return;
      hb.classList.remove("-o");
      hb.setAttribute("data-liked", "1");
      const svg = hb.querySelector("svg");
      if (svg) { svg.setAttribute("fill", "currentColor"); svg.setAttribute("stroke-width", "0"); }
    });
    const onShareClick = (e) => {
      const bar = e.target.closest && e.target.closest(".share-modal");
      if (!bar) return;
      const btn = e.target.closest("button");
      if (!btn || !bar.contains(btn)) return;
      e.preventDefault();
      const idx = Array.prototype.indexOf.call(bar.querySelectorAll("button"), btn);
      if (idx < 0) return;
      if (idx >= 1 && idx <= 3) { openShare(idx, bar); return; }
      if (idx === 0) { pushToast("info", "海报功能将在后续版本上线"); return; }
      const id = Number(bar.getAttribute("data-post-id"));
      const arr = readLiked();
      if (arr.indexOf(id) !== -1) { pushToast("warning", "您已经点过赞了"); return; }
      const closeInfo = pushToast("info", "正在处理点赞...");
      arr.push(id);
      try { localStorage.setItem("liked", JSON.stringify(arr)); } catch (e2) {}
      const n = (Number(bar.getAttribute("data-likes")) || 0) + 1;
      bar.setAttribute("data-likes", String(n));
      bar.lastChild.textContent = " " + n;
      setTimeout(closeInfo, 120);
      setTimeout(() => pushToast("success", "点赞成功！"), 140);
      setTimeout(() => {
        btn.classList.remove("-o");
        btn.setAttribute("data-liked", "1");
        const svg = btn.querySelector("svg");
        if (svg) { svg.setAttribute("fill", "currentColor"); svg.setAttribute("stroke-width", "0"); }
      }, 240);
    };
    const onTipOver = (e) => {
      const btn = e.target.closest && e.target.closest(".share-modal button");
      if (!btn) return;
      const bar = btn.closest(".share-modal");
      const idx = Array.prototype.indexOf.call(bar.querySelectorAll("button"), btn);
      let text = TIPS[idx];
      if (idx === 4 && btn.getAttribute("data-liked")) text = "已点赞";
      if (text) showTip(btn, text);
    };
    const onTipOut = (e) => {
      const btn = e.target.closest && e.target.closest(".share-modal button");
      if (btn && e.relatedTarget && btn.contains(e.relatedTarget)) return;
      hideTip();
    };
    document.addEventListener("click", onShareClick);
    document.addEventListener("mouseover", onTipOver);
    document.addEventListener("mouseout", onTipOut);

    pageFx();

    window.addEventListener("pagehide", () => {
      if (fx.flipTimer) clearInterval(fx.flipTimer);
      if (fx.io) fx.io.disconnect();
      clearTimeout(fx.fallback);
      clearTimeout(disappearTimer);
      hideTip();
    });
  }

  const fx = { io: null, fallback: null, flipTimer: null };
  function pageFx() {
    if (fx.flipTimer) { clearInterval(fx.flipTimer); fx.flipTimer = null; }
    if (fx.io) { fx.io.disconnect(); fx.io = null; }
    clearTimeout(fx.fallback);

    const SEL = ".sk-frame .post-card-col, .sk-frame .sk-section, .sk-frame .post-wrapper, .sk-frame .sk-crumbs";
    if ("IntersectionObserver" in window) {
      fx.io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          en.target.classList.add("is-in");
          fx.io.unobserve(en.target);
        }
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.04 });
    }
    const targets = Array.from(document.querySelectorAll(SEL));
    targets.forEach((el) => {
      if (el.classList.contains("post-card-col")) {
        const i = Array.prototype.indexOf.call(el.parentElement ? el.parentElement.children : [], el);
        el.style.transitionDelay = Math.min(i % 4, 3) * 0.07 + "s";
      }
      el.classList.add("sk-reveal");
      if (fx.io) fx.io.observe(el);
    });
    fx.fallback = setTimeout(() => targets.forEach((el) => el.classList.add("is-in")), 1600);

    const sec = document.getElementById("cardFlip");
    if (sec) {
      const pages = Array.prototype.slice.call(sec.querySelectorAll(".cardFlip-slider .page"));
      const n = pages.length;
      const HERO = pages.map((pg) => ({
        url: pg.getAttribute("data-url") || "/",
        title: pg.querySelector(".post") ? pg.querySelector(".post").textContent : "",
        cat: pg.getAttribute("data-cat") || "",
        date: pg.getAttribute("data-date") || "",
        reads: pg.getAttribute("data-reads") || "0",
        comments: pg.getAttribute("data-comments") || "0",
      }));
      const POS = ["current", "future0", "future1", "future2", "past1"];
      let cur = 0;
      const draw = () => {
        pages.forEach((pg, i) => {
          const off = (i - cur + n) % n;
          pg.className = "page " + (POS[off] || "past1");
        });
        const p = HERO[cur];
        const tax = sec.querySelector(".meta .taxonomy");
        if (tax) tax.textContent = p.cat;
        const titleA = sec.querySelector(".meta a.title");
        titleA.setAttribute("href", p.url);
        titleA.textContent = p.title;
        sec.querySelector(".meta time").textContent = p.date;
        sec.querySelector(".meta .reads").textContent = p.reads + " 阅读";
        sec.querySelector(".meta .comments").textContent = p.comments + " 条评论";
        sec.querySelector(".meta a.goto").setAttribute("href", p.url);
      };
      const go = (d) => { cur = (cur + d + n) % n; draw(); };
      const next = sec.querySelector(".navigator .next");
      const prev = sec.querySelector(".navigator .prev");
      if (next) next.addEventListener("click", () => go(1));
      if (prev) prev.addEventListener("click", () => go(-1));
      draw();
      if (n > 1) fx.flipTimer = setInterval(() => go(1), 5000);
    }

    const row = document.querySelector(".post-card-nested-row");
    if (row) {
      const mainCol = row.closest(".main-column");
      let colWidth = 0;
      if (mainCol) {
        const probe = document.createElement("div");
        probe.className = "row";
        const el = document.createElement("div");
        el.className = "el post-card-col col-xxs-6 col-xs-6 col-sm-4 col-md-4 col-lg-3 col-xl-3";
        el.style.cssText = "padding:0;margin:0;visibility:hidden;";
        probe.style.cssText = "position:absolute;left:0;top:0;width:" + mainCol.clientWidth + "px;visibility:hidden;pointer-events:none;";
        probe.appendChild(el);
        mainCol.appendChild(probe);
        colWidth = el.getBoundingClientRect().width;
        probe.remove();
      }
      if (!colWidth || !isFinite(colWidth)) colWidth = 300;
      let total = 15;
      row.querySelectorAll(".post-card-nested-col").forEach((col) => {
        col.style.width = colWidth + "px";
        col.style.opacity = "1";
        total += colWidth;
      });
      if (total > row.getBoundingClientRect().width) row.classList.add("native-scroll");
    }
  }
  document.addEventListener("rv:nav", pageFx);

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  let pjaxSeq = 0;
  let pjaxKey = location.pathname + location.search;
  function pjaxEligible(a) {
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
  async function pjaxGo(rawUrl, push) {
    const seq = ++pjaxSeq;
    const wantUrl = new URL(rawUrl, location.href);
    let res;
    try {
      res = await fetch(wantUrl.pathname + wantUrl.search, { credentials: "same-origin" });
    } catch {
      if (seq === pjaxSeq) location.href = wantUrl.href;
      return;
    }
    if (seq !== pjaxSeq) return;
    if (!res.ok || (res.headers.get("content-type") || "").indexOf("text/html") < 0) {
      location.href = wantUrl.href;
      return;
    }
    const html = await res.text();
    if (seq !== pjaxSeq) return;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const nextMain = doc.getElementById("sk-main");
    if (!nextMain) { location.href = res.url || wantUrl.href; return; }
    const main = document.getElementById("sk-main");
    main.innerHTML = nextMain.innerHTML;
    const t = doc.querySelector("title");
    if (t) document.title = t.textContent;
    const finalUrl = new URL(res.url || wantUrl.href);
    if (push) {
      history.replaceState({ rv: 1, y: window.scrollY }, "");
      history.pushState({ rv: 1, y: 0 }, "", finalUrl.pathname + finalUrl.search + finalUrl.hash);
    }
    pjaxKey = finalUrl.pathname + finalUrl.search;
    document.dispatchEvent(new CustomEvent("rv:nav"));
    if (finalUrl.hash) {
      const el = document.getElementById(finalUrl.hash.slice(1)) || document.querySelector(finalUrl.hash);
      if (el) { el.scrollIntoView(); return; }
    }
    window.scrollTo(0, push ? 0 : ((history.state && history.state.y) || 0));
  }
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (!document.getElementById("sk-main")) return;
    const a = e.target.tagName === "A" ? e.target : e.target.closest && e.target.closest("a");
    const url = pjaxEligible(a);
    if (!url) return;
    e.preventDefault();
    pjaxGo(url.pathname + url.search + url.hash, true);
  });
  window.addEventListener("popstate", () => {
    if (!document.getElementById("sk-main")) { location.reload(); return; }
    if (location.pathname + location.search === pjaxKey) return;
    pjaxGo(location.pathname + location.search, false);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
