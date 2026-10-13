(function () {
  "use strict";

  function notice(form, text) {
    var el = form.querySelector("[data-comment-notice]") ||
      document.querySelector("[data-comment-notice]");
    if (!el) return;
    el.textContent = text;
    el.style.display = text ? "block" : "none";
  }

  function setReply(form, parentId) {
    var hidden = form.querySelector('input[name="parentId"]');
    if (hidden) hidden.value = parentId || "";
    var cancel = form.querySelector("[data-comment-cancel]");
    if (cancel) cancel.style.display = parentId ? "inline-flex" : "none";
    var label = form.querySelector("[data-submit-label]");
    if (label) label.textContent = parentId ? "回复评论" : "发表评论";
  }

  function bringFormIntoView(form) {
    var box = form.querySelector(".input") || form;
    try { box.scrollIntoView({ behavior: "smooth", block: "center" }); }
    catch (e) { box.scrollIntoView(); }
    var ta = form.querySelector("textarea");
    if (ta) ta.focus({ preventScroll: true });
  }

  async function submitForm(form) {
    var ta = form.querySelector('textarea[name="content"]');
    var content = ta ? ta.value.trim() : "";
    var requireFields = form.getAttribute("data-require") === "1";
    var hasGuest = !!form.querySelector('input[name="authorName"]');
    var nameEl = form.querySelector('input[name="authorName"]');
    var emailEl = form.querySelector('input[name="authorEmail"]');
    var urlEl = form.querySelector('input[name="authorUrl"]');
    var name = nameEl ? nameEl.value.trim() : "";
    var email = emailEl ? emailEl.value.trim() : "";
    var url = urlEl ? urlEl.value.trim() : "";

    if (!content) return notice(form, "请填写评论内容！");
    if (hasGuest && requireFields && !name) return notice(form, "昵称必填！");
    if (hasGuest && requireFields && !email) return notice(form, "邮箱必填！");
    if (hasGuest && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return notice(form, "请输入正确的邮箱格式！");

    var payload = {
      postId: Number(form.getAttribute("data-post-id")),
      postType: form.getAttribute("data-post-type") || "post",
      content: ta.value,
    };
    var parent = form.querySelector('input[name="parentId"]');
    if (parent && parent.value) payload.parentId = Number(parent.value);
    if (hasGuest) {
      payload.authorName = name || "匿名";
      if (email) payload.authorEmail = email;
      if (url) payload.authorUrl = url;
    }

    var btn = form.querySelector(".btn-submit");
    if (btn) btn.disabled = true;
    try {
      var res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok) {
        if (data.isPublic) {
          notice(form, "评论已发布");
          setTimeout(function () { window.location.reload(); }, 500);
        } else {
          ta.value = "";
          setReply(form, null);
          notice(form, "评论已提交，等待审核");
        }
      } else {
        notice(form, data.error || "提交失败");
      }
    } catch (e) {
      notice(form, "提交失败");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  var emojiPromise = null;
  function loadEmoji() {
    if (!emojiPromise)
      emojiPromise = fetch("/api/emojis").then(function (r) {
        return r.ok ? r.json() : null;
      });
    return emojiPromise;
  }

  function buildPanel(data) {
    var wrap = document.createElement("span");
    wrap.className = "emoji-panel";
    wrap.onmousedown = function (e) { e.preventDefault(); };

    var groups = Object.keys(data).map(function (name) {
      return { name: name, items: data[name] };
    });
    var inner = '<div class="panel">';
    groups.forEach(function (g, i) {
      inner +=
        '<section class="emoji-group" data-emoji-group="' + i + '">' +
        '<div class="title">' + g.name + "</div><div class=\"emoji-grid\">" +
        g.items
          .map(function (e) {
            return (
              '<button type="button" class="emoji" data-emoji="' + e + '">' + e + "</button>"
            );
          })
          .join("") +
        "</div></section>";
    });
    inner += "</div>";
    inner +=
      '<div class="tabs">' +
      groups
        .map(function (g, i) {
          return (
            '<button type="button" title="' + g.name + '" data-emoji-tab="' + i + '">' +
            g.items[0] +
            "</button>"
          );
        })
        .join("") +
      "</div>";
    wrap.innerHTML = inner;
    return wrap;
  }

  async function toggleEmoji(form) {
    var host = form.querySelector("[data-emoji-panel]");
    if (!host) return;
    var open = host.classList.toggle("is-in");
    host.setAttribute("aria-hidden", open ? "false" : "true");
    
    
    var btn = form.querySelector("[data-comment-emoji]");
    if (btn) btn.classList.toggle("is-active", open);
    if (open && !host.querySelector(".emoji-panel")) {
      var data = await loadEmoji();
      if (!data) { host.classList.remove("is-in"); return; }
      host.appendChild(buildPanel(data));
      host.querySelectorAll("[data-emoji-tab]").forEach(function (b) {
        b.addEventListener("click", function () {
          var sec = host.querySelector('[data-emoji-group="' + b.getAttribute("data-emoji-tab") + '"]');
          if (sec) host.querySelector(".panel").scrollTop = sec.offsetTop;
        });
      });
    }
  }

  function insertEmoji(form, emoji) {
    var ta = form.querySelector('textarea[name="content"]');
    if (!ta) return;
    var start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    var end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
    var pos = start + emoji.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  }

  function injectScript(opts) {
    if (opts.id && document.getElementById(opts.id)) return;
    var s = document.createElement("script");
    if (opts.id) s.id = opts.id;
    s.src = opts.src;
    s.async = true;
    Object.keys(opts.attrs || {}).forEach(function (k) {
      s.setAttribute(k, opts.attrs[k]);
    });
    if (opts.onLoad) s.addEventListener("load", opts.onLoad);
    (opts.appendTo || document.body).appendChild(s);
  }
  function hasGlobal(n) { return typeof window[n] !== "undefined"; }

  function injectProvider(container) {
    if (container.getAttribute("data-injected")) return;
    container.setAttribute("data-injected", "1");
    var cfg;
    try { cfg = JSON.parse(container.getAttribute("data-config") || "{}"); } catch (e) { return; }
    var p = container.getAttribute("data-comment-provider");

    if (p === "giscus" && cfg.giscus && cfg.giscus.repo) {
      var a = {
        src: "https://giscus.app/client.js",
        "data-repo": cfg.giscus.repo,
        "data-repo-id": cfg.giscus.repoId,
        "data-category": cfg.giscus.category,
        "data-category-id": cfg.giscus.categoryId,
        "data-mapping": cfg.giscus.mapping,
        "data-strict": "0",
        "data-reactions-enabled": cfg.giscus.reactions ? "1" : "0",
        "data-emit-metadata": "0",
        "data-input-position": "bottom",
        "data-lang": "zh-CN",
        "data-theme": cfg.giscus.theme || "preferred_color_scheme",
        crossorigin: "anonymous",
      };
      injectScript({ src: a.src, id: "giscus-script", attrs: a, appendTo: container });
    } else if (p === "utterances" && cfg.utterances && cfg.utterances.repo) {
      injectScript({
        src: "https://utteranc.es/client.js",
        id: "utterances-script",
        attrs: {
          repo: cfg.utterances.repo,
          "issue-term": cfg.utterances.term,
          label: "评论",
          theme: "preferred-color-scheme",
          crossorigin: "anonymous",
        },
        appendTo: container,
      });
    } else if (p === "artalk" && cfg.artalk && cfg.artalk.server) {
      injectScript({
        src: "https://cdn.jsdelivr.net/npm/artalk@2/dist/Artalk.js",
        id: "artalk-script",
        appendTo: container,
        onLoad: function () {
          if (hasGlobal("Artalk"))
            window.Artalk.init({ el: container, server: cfg.artalk.server, site: cfg.artalk.site || location.hostname });
        },
      });
      var l1 = document.createElement("link");
      l1.id = "artalk-style"; l1.rel = "stylesheet";
      l1.href = "https://cdn.jsdelivr.net/npm/artalk@2/dist/Artalk.css";
      document.head.appendChild(l1);
    } else if (p === "waline" && cfg.waline && cfg.waline.server) {
      injectScript({
        src: "https://cdn.jsdelivr.net/npm/@waline/client@v3/dist/waline.js",
        id: "waline-script",
        appendTo: container,
        onLoad: function () {
          if (hasGlobal("Waline"))
            window.Waline.init({ el: container, serverURL: cfg.waline.server, path: location.pathname, reaction: true, locale: { placeholder: "说点什么吧～" } });
        },
      });
      var l2 = document.createElement("link");
      l2.id = "waline-style"; l2.rel = "stylesheet";
      l2.href = "https://cdn.jsdelivr.net/npm/@waline/client@v3/dist/waline.css";
      document.head.appendChild(l2);
    } else if (p === "twikoo" && cfg.twikoo && cfg.twikoo.envId) {
      injectScript({
        src: "https://cdn.jsdelivr.net/npm/twikoo@1.6.41/dist/twikoo.all.min.js",
        id: "twikoo-script",
        appendTo: container,
        onLoad: function () {
          if (hasGlobal("twikoo")) window.twikoo.init({ envId: cfg.twikoo.envId, el: container });
        },
      });
    } else if (p === "disqus" && cfg.disqus && cfg.disqus.shortname) {
      window.disqus_config = function () {
        this.page.url = location.href;
        this.page.identifier = location.pathname;
      };
      injectScript({
        src: "https://" + cfg.disqus.shortname + ".disqus.com/embed.js",
        id: "disqus-script",
        appendTo: container,
      });
    } else {
      container.textContent = "未配置第三方评论服务参数，请在「站点设置 → 评论」中填写。";
    }
  }

  function scanProviders(root) {
    (root || document).querySelectorAll("[data-comment-provider]").forEach(injectProvider);
  }

  function onClick(e) {
    var reply = e.target.closest && e.target.closest("[data-comment-reply]");
    if (reply) {
      var formR = reply.closest("form[data-comment-form]") ||
        document.querySelector("form[data-comment-form]");
      if (formR) {
        setReply(formR, reply.getAttribute("data-comment-reply"));
        bringFormIntoView(formR);
      }
      return;
    }
    var cancel = e.target.closest && e.target.closest("[data-comment-cancel]");
    if (cancel) {
      var formC = cancel.closest("form");
      if (formC) { setReply(formC, null); bringFormIntoView(formC); }
      return;
    }
    var emoji = e.target.closest && e.target.closest("[data-emoji]");
    if (emoji && emoji.closest("[data-emoji-panel]")) {
      var formE = emoji.closest("form");
      if (formE) insertEmoji(formE, emoji.getAttribute("data-emoji"));
      return;
    }
    var emojiBtn = e.target.closest && e.target.closest("[data-comment-emoji]");
    if (emojiBtn) {
      var formB = emojiBtn.closest("form");
      if (formB) toggleEmoji(formB);
    }
  }

  function onSubmit(e) {
    var form = e.target.closest && e.target.closest("form[data-comment-form]");
    if (!form) return;
    e.preventDefault();
    submitForm(form);
  }

  function onFocus(e) {
    var form = e.target.closest && e.target.closest("form[data-comment-form]");
    var box = form && form.querySelector(".input");
    if (box) box.classList.add("is_focused");
  }
  function onBlur(e) {
    var form = e.target.closest && e.target.closest("form[data-comment-form]");
    var box = form && form.querySelector(".input");
    if (box) box.classList.remove("is_focused");
  }

  function onMouseDown(e) {
    var panel = e.target.closest && e.target.closest("[data-emoji-panel]");
    var btn = e.target.closest && e.target.closest("[data-comment-emoji]");
    if (panel || btn) return;
    document.querySelectorAll("[data-emoji-panel].is-in").forEach(function (host) {
      host.classList.remove("is-in");
      host.setAttribute("aria-hidden", "true");
      
      var form = host.closest && host.closest("form[data-comment-form]");
      var trigger = form && form.querySelector("[data-comment-emoji]");
      if (trigger) trigger.classList.remove("is-active");
    });
  }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("mousedown", onMouseDown);
    scanProviders(document);
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          if (nodes[j].nodeType === 1 && nodes[j].querySelector) scanProviders(nodes[j]);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
