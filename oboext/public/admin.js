(function () {
  "use strict";
  if (window.__admBound) return;
  window.__admBound = true;

  function toast(text, kind) {
    var layer = document.querySelector(".adm-toast-wrap");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "adm-toast-wrap";
      document.body.appendChild(layer);
    }
    var el = document.createElement("div");
    el.className = "adm-toast " + (kind || "");
    el.textContent = text;
    layer.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      el.style.transition = "opacity .25s";
      setTimeout(function () { el.remove(); }, 260);
    }, 2400);
  }
  window.admToast = toast;

  async function api(method, url, body) {
    var init = { method: method, headers: {} };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var res = await fetch(url, init);
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var msg = (data && data.error) || "请求失败 (" + res.status + ")";
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  window.admApi = api;

  function formObject(form) {
    var out = {};
    new FormData(form).forEach(function (v, k) {
      if (v === "") return;
      if (k.slice(-2) === "[]") {
        var key = k.slice(0, -2);
        (out[key] = out[key] || []).push(v);
      } else if (out[k] !== undefined) {
        out[k] = Array.isArray(out[k]) ? out[k].concat(v) : [out[k], v];
      } else {
        out[k] = v;
      }
    });
    form.querySelectorAll("input[type=checkbox][data-bool]").forEach(function (cb) {
      out[cb.name] = cb.checked;
    });
    form.querySelectorAll("input[type=number][data-num]").forEach(function (n) {
      if (n.value !== "") out[n.name] = Number(n.value);
    });
    return out;
  }
  window.admFormObject = formObject;

  document.addEventListener("click", async function (e) {
    var t = e.target.closest && e.target.closest("[data-adm-act]");
    if (!t || !document.body.classList.contains("adm-body")) return;
    var act = t.getAttribute("data-adm-act");

    if (act === "logout") {
      e.preventDefault();
      await api("POST", "/api/auth/logout");
      window.location.href = "/admin/login";
      return;
    }

    if (act === "delete") {
      e.preventDefault();
      if (!confirm(t.getAttribute("data-confirm") || "确认删除？此操作不可撤销。")) return;
      try {
        await api("DELETE", t.getAttribute("data-url"));
        toast("已删除", "ok");
        setTimeout(function () { window.location.reload(); }, 500);
      } catch (err) { toast(err.message, "err"); }
      return;
    }

    if (act === "comment") {
      e.preventDefault();
      var id = t.getAttribute("data-id");
      var what = t.getAttribute("data-what");
      try {
        if (what === "delete") await api("DELETE", "/api/comments/" + id);
        else await api("PATCH", "/api/comments/" + id, { status: what });
        toast("已更新", "ok");
        setTimeout(function () { window.location.reload(); }, 450);
      } catch (err) { toast(err.message, "err"); }
      return;
    }

    if (act === "bulk") {
      e.preventDefault();
      var ids = Array.prototype.map
        .call(document.querySelectorAll(".adm-check:checked"), function (c) {
          return Number(c.value);
        });
      if (!ids.length) return toast("请先勾选项目");
      var op = t.getAttribute("data-op");
      if (op === "delete" && !confirm("确认删除选中的 " + ids.length + " 篇文章？")) return;
      try {
        await api("PATCH", "/api/posts", { ids: ids, action: op });
        toast("批量操作完成", "ok");
        setTimeout(function () { window.location.reload(); }, 500);
      } catch (err) { toast(err.message, "err"); }
      return;
    }

    if (act === "check-all") {
      document.querySelectorAll(".adm-check").forEach(function (c) {
        c.checked = t.checked;
      });
      return;
    }

    if (act === "add-block") {
      e.preventDefault();
      if (window.__admEditor) window.__admEditor.addBlock(t.getAttribute("data-type") || "paragraph");
      return;
    }

    if (act === "add-meta") {
      e.preventDefault();
      var ed = window.__admEditor;
      if (ed && ed.kind === "page") {
        ed.metas.push({ key: "", value: "" });
        ed.renderMetas();
        var box = ed.root.querySelector("[data-adm-metas]");
        if (box && box.lastElementChild) box.lastElementChild.querySelector("input").focus();
      }
      return;
    }

    if (act === "tax-edit" || act === "tax-new") {
      e.preventDefault();
      var tform = document.querySelector(t.getAttribute("data-form"));
      if (!tform) return;
      var submit = tform.querySelector("[type=submit]");
      if (act === "tax-new") {
        tform.reset();
        tform.querySelector('[name=id]').value = "";
        if (submit) submit.textContent = tform.getAttribute("data-add-label") || "新增";
        return;
      }
      tform.querySelector('[name=id]').value = t.getAttribute("data-id") || "";
      Object.keys({ name: 1, slug: 1, description: 1, icon: 1, parentid: 1 }).forEach(function (attr) {
        var field = attr === "parentid" ? "parentId" : attr;
        var el = tform.querySelector("[name=" + field + "]");
        if (el) el.value = t.getAttribute("data-" + attr) || "";
      });
      if (submit) submit.textContent = "保存修改";
      tform.scrollIntoView({ behavior: "smooth" });
      return;
    }

    if (act === "user-edit") {
      e.preventDefault();
      var data = JSON.parse(t.getAttribute("data-user"));
      var form = document.querySelector("[data-adm-user-form]");
      if (!form) return;
      form.querySelector('[name=id]').value = data.id;
      form.querySelector('[name=name]').value = data.name;
      form.querySelector('[name=email]').value = data.email || "";
      form.querySelector('[name=role]').value = data.role;
      form.querySelector('[name=bio]').value = data.bio || "";
      var pw = form.querySelector('[name=password]');
      if (pw) pw.placeholder = "留空则不修改密码";
      form.querySelector("[type=submit]").textContent = "保存用户";
      form.scrollIntoView({ behavior: "smooth" });
      return;
    }
  });

  document.addEventListener("submit", async function (e) {
    var form = e.target;
    if (!form.hasAttribute("data-adm-form")) return;
    e.preventDefault();
    var kind = form.getAttribute("data-adm-form");
    var btn = form.querySelector("[type=submit]");
    if (btn) btn.disabled = true;
    try {
      if (kind === "login") {
        var r = await api("POST", "/api/auth/login", {
          account: form.account.value,
          password: form.password.value,
        });
        toast("欢迎回来，" + r.user.name, "ok");
        window.location.href = "/admin";
      } else if (kind === "setup") {
        try {
          await submitSetup(form);
          toast("安装完成", "ok");
          window.location.href = "/admin";
        } catch (err) {
          var errEl = form.querySelector("[data-setup-error]");
          if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
          if (btn) btn.disabled = false;
        }
      } else if (kind === "create-category" || kind === "create-tag") {
        var base = kind === "create-category" ? "/api/categories" : "/api/tags";
        var id = form.querySelector('[name=id]').value;
        var payload = formObject(form);
        delete payload.id;
        if (id) await api("PUT", base + "/" + id, payload);
        else await api("POST", base, payload);
        toast("已保存", "ok");
        setTimeout(function () { window.location.reload(); }, 500);
      } else if (kind === "settings") {
        await api("PATCH", "/api/settings", formObject(form));
        toast("设置已保存", "ok");
        setTimeout(function () { window.location.reload(); }, 600);
      } else if (kind === "user") {
        var uid = form.querySelector('[name=id]').value;
        var body = formObject(form);
        delete body.id;
        if (!body.password) delete body.password;
        if (uid) await api("PUT", "/api/users/" + uid, body);
        else await api("POST", "/api/users", body);
        toast("用户已保存", "ok");
        setTimeout(function () { window.location.reload(); }, 500);
      } else if (kind === "post" || kind === "page") {
        var as = e.submitter && e.submitter.getAttribute("data-save-as");
        await window.__admEditor.save(as || "");
      }
    } catch (err) {
      toast(err.message, "err");
      if (btn) btn.disabled = false;
    }
  });

  function toLocalInput(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  async function submitSetup(form) {
    var field = function (n) {
      var el = form.elements[n];
      return el ? String(el.value).trim() : "";
    };
    var checked = function (n) {
      var el = form.querySelector('input[name="' + n + '"]:checked');
      return el ? el.value : "";
    };
    var driver = checked("driver") || "pglite";
    var storage = checked("storage") || "local";
    var dbUrl = field("dbUrl");
    var blobToken = field("blobToken");
    var label = form.querySelector("[data-setup-label]");

    if (driver === "postgres" && !dbUrl) throw new Error("选择远程数据库时请填写连接串");
    if (storage === "vercel-blob" && !blobToken)
      throw new Error("选择 Vercel Blob 时请填写 Blob 读写令牌");

    if (label) label.textContent = "初始化中…";
    try {
      var dbRes = await fetch("/api/db-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver: driver, url: dbUrl, storage: storage, blobToken: blobToken }),
      });
      if (!dbRes.ok) {
        var dbErr = await dbRes.json().catch(function () { return {}; });
        throw new Error(dbErr.error || dbErr.message || "数据库配置失败");
      }
      await api("POST", "/api/setup", {
        siteTitle: field("siteTitle"),
        siteDescription: field("siteDescription"),
        tagline: field("tagline"),
        footerText: field("footerText"),
        email: field("email"),
        name: field("name"),
        password: form.elements["password"].value,
      });
    } catch (err) {
      if (label) label.textContent = "完成初始化";
      throw err;
    }
  }

  document.addEventListener("change", function (e) {
    var input = e.target;
    if (!input || !input.hasAttribute || !input.hasAttribute("data-su")) return;
    var group = input.getAttribute("data-su");
    document.querySelectorAll("[data-su-card^='" + group + "-']").forEach(function (card) {
      var radio = card.querySelector("input");
      card.classList.toggle("is-on", !!radio && radio.checked);
    });
    document.querySelectorAll("[data-su-panel^='" + group + "-']").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-su-panel") !== group + "-" + input.value;
    });
  });

  function BlockEditor(root) {
    this.root = root;
    this.kind = root.getAttribute("data-adm-form") === "page" ? "page" : "post";
    this.data = JSON.parse(
      root.getAttribute(this.kind === "page" ? "data-page" : "data-post") || "{}",
    );
    this.entity = this.kind === "page" ? this.data.page : this.data.post;
    this.listEl = root.querySelector(".adm-blocks");
    this.blocks = (this.entity && this.entity.content) || [];
    this.metas = (this.kind === "page" && this.entity && this.entity.metaList) || [];
    this.render();
    this.renderMetas();
  }
  BlockEditor.TYPES = [
    ["paragraph", "段落"], ["heading", "标题"], ["image", "图片"],
    ["quote", "引用"], ["code", "代码"], ["list", "列表"],
    ["divider", "分割线"], ["html", "HTML"],
  ];
  BlockEditor.prototype.render = function () {
    var self = this;
    this.listEl.innerHTML = "";
    this.blocks.forEach(function (b, i) {
      self.listEl.appendChild(self.row(b, i));
    });
  };
  BlockEditor.prototype.row = function (b, i) {
    var self = this;
    var el = document.createElement("div");
    el.className = "adm-block" + (b.type === "code" ? " code" : "");
    var bar = '<div class="adm-block-bar"><select class="adm-select" data-f="type">';
    BlockEditor.TYPES.forEach(function (tp) {
      bar += '<option value="' + tp[0] + '"' + (b.type === tp[0] ? " selected" : "") + ">" + tp[1] + "</option>";
    });
    bar += '</select><span class="spacer" style="flex:1"></span>';
    bar += '<button type="button" class="adm-iconbtn" data-move="-1">↑</button>';
    bar += '<button type="button" class="adm-iconbtn" data-move="1">↓</button>';
    bar += '<button type="button" class="adm-iconbtn danger" data-del="1">删除</button></div>';
    el.innerHTML = bar;
    var addInput = function (name, placeholder, value, kind) {
      var inp = document.createElement("input");
      inp.className = "adm-input meta";
      inp.setAttribute("data-f", name);
      inp.placeholder = placeholder;
      if (kind) inp.type = kind;
      if (value != null) inp.value = value;
      el.appendChild(inp);
    };
    if (b.type === "heading") addInput("level", "级别 1-4", b.level || 2, "number");
    if (b.type === "image") {
      addInput("url", "图片 URL", b.url || "");
      addInput("alt", "替代文本", b.alt || "");
      addInput("caption", "说明文字", b.caption || "");
    }
    if (b.type === "quote") {
      addInput("cite", "引用来源（可选）", b.cite || "");
      addInput("title", "来源标题（可选）", b.title || "");
    }
    if (b.type === "code") addInput("language", "语言（如 js）", b.language || "");
    if (b.type === "list") addInput("ordered", "有序列表填 1，否则留空", b.ordered ? "1" : "");
    var needText = ["paragraph", "heading", "quote", "code", "list", "html"].indexOf(b.type) >= 0;
    if (needText) {
      var ta = document.createElement("textarea");
      ta.className = "adm-textarea";
      ta.setAttribute("data-f", "text");
      ta.placeholder =
        b.type === "list" ? "每行一个列表项" : b.type === "html" ? "原始 HTML" : "正文内容";
      if (b.type === "list") ta.value = (b.items || []).join("\n");
      else ta.value = b.type === "code" ? b.code || "" : b.text || (b.html || "");
      el.appendChild(ta);
    }
    el.querySelector('[data-f="type"]').addEventListener("change", function (ev) {
      var nb = self.defaultBlock(ev.target.value);
      nb.id = b.id;
      self.blocks[i] = nb;
      self.render();
    });
    el.addEventListener("input", function () { self.collect(); });
    el.querySelector("[data-del]").addEventListener("click", function () {
      self.blocks.splice(i, 1); self.render();
    });
    el.querySelectorAll("[data-move]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var d = Number(btn.getAttribute("data-move"));
        var j = i + d;
        if (j < 0 || j >= self.blocks.length) return;
        var tmp = self.blocks[i]; self.blocks[i] = self.blocks[j]; self.blocks[j] = tmp;
        self.render();
      });
    });
    return el;
  };
  BlockEditor.prototype.defaultBlock = function (type) {
    var id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (type === "heading") return { id: id, type: "heading", level: 2, text: "" };
    if (type === "image") return { id: id, type: "image", url: "", alt: "", caption: "" };
    if (type === "quote") return { id: id, type: "quote", text: "", cite: "", title: "" };
    if (type === "code") return { id: id, type: "code", language: "", code: "" };
    if (type === "list") return { id: id, type: "list", ordered: false, items: [] };
    if (type === "divider") return { id: id, type: "divider" };
    if (type === "html") return { id: id, type: "html", html: "" };
    return { id: id, type: "paragraph", text: "" };
  };
  BlockEditor.prototype.addBlock = function (type) {
    this.blocks.push(this.defaultBlock(type));
    this.render();
    this.listEl.lastElementChild.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  BlockEditor.prototype.collect = function () {
    var self = this;
    this.listEl.querySelectorAll(".adm-block").forEach(function (el, i) {
      var b = self.blocks[i];
      el.querySelectorAll("[data-f]").forEach(function (node) {
        var k = node.getAttribute("data-f");
        var v = node.value;
        if (b.type === "heading" && k === "level") b.level = Math.min(4, Math.max(1, Number(v) || 2));
        else if (b.type === "list" && k === "ordered") b.ordered = v === "1";
        else if (b.type === "list" && k === "text") b.items = v.split("\n");
        else if (b.type === "code" && k === "text") b.code = v;
        else if (b.type === "html" && k === "text") b.html = v;
        else if (k !== "type" && k !== "level") b[k] = v;
      });
    });
  };
  BlockEditor.prototype.renderMetas = function () {
    if (this.kind !== "page") return;
    var box = this.root.querySelector("[data-adm-metas]");
    if (!box) return;
    box.innerHTML = "";
    this.metas.forEach(function (m) {
      var row = document.createElement("div");
      row.className = "adm-meta-row";
      var k = document.createElement("input");
      k.className = "adm-input adm-meta-key";
      k.placeholder = "键";
      k.value = m.key || "";
      var v = document.createElement("input");
      v.className = "adm-input adm-meta-val";
      v.placeholder = "值";
      v.value = m.value || "";
      var del = document.createElement("button");
      del.type = "button";
      del.className = "adm-iconbtn danger";
      del.textContent = "✕";
      del.addEventListener("click", function () {
        row.remove();
      });
      row.appendChild(k);
      row.appendChild(v);
      row.appendChild(del);
      box.appendChild(row);
    });
  };
  BlockEditor.prototype.collectMetas = function () {
    var box = this.root.querySelector("[data-adm-metas]");
    if (!box) return [];
    return Array.prototype.map.call(box.querySelectorAll(".adm-meta-row"), function (row) {
      return {
        key: row.querySelector(".adm-meta-key").value,
        value: row.querySelector(".adm-meta-val").value,
      };
    });
  };
  BlockEditor.prototype.payload = function (status) {
    this.collect();
    var form = this.root;
    var body = formObject(form);
    body.content = this.blocks;
    if (this.kind === "post") {
      body.categoryIds = Array.prototype.map.call(
        form.querySelectorAll('[name="categoryIds[]"]:checked'), function (c) { return Number(c.value); });
      body.tagIds = Array.prototype.map.call(
        form.querySelectorAll('[name="tagIds[]"]:checked'), function (c) { return Number(c.value); });
      body.pinned = !!form.querySelector('[name=pinned]') && form.querySelector('[name=pinned]').checked;
    } else {
      var pid = form.querySelector('[name=parentId]');
      if (pid && pid.value !== "") body.parentId = Number(pid.value);
      body.metas = this.collectMetas();
    }
    if (status) body.status = status;
    if (body.commentStatus === "on") body.commentStatus = "open";
    return body;
  };
  BlockEditor.prototype.save = async function (status) {
    var body = this.payload(status);
    var base = this.kind === "page" ? "/api/pages" : "/api/posts";
    var listPath = this.kind === "page" ? "/admin/pages/" : "/admin/posts/";
    var id = this.entity ? this.entity.id : null;
    var saved;
    if (id) saved = await api("PUT", base + "/" + id, body);
    else saved = await api("POST", base, body);
    toast("已保存", "ok");
    if (!id) window.history.replaceState(null, "", listPath + saved.id);
    this.entity = saved;
    if (this.kind === "page") {
      this.data.page = saved;
      this.root.setAttribute("data-page", JSON.stringify(this.data));
    } else {
      this.data.post = saved;
      this.root.setAttribute("data-post", JSON.stringify(this.data));
    }
    this.metas = (this.kind === "page" && saved.metaList) || this.metas;
    this.renderMetas();
    var btn = this.root.querySelector("[type=submit]");
    if (btn) btn.disabled = false;
    return saved;
  };

  function initEditor() {
    var root = document.querySelector("[data-adm-editor]");
    if (!root || root.__bound) return;
    root.__bound = true;
    window.__admEditor = new BlockEditor(root);
    var editor = window.__admEditor;
    var entity = editor.entity;
    if (entity) {
      if (editor.kind === "post") {
        (entity.categoryIds || []).forEach(function (id) {
          var cb = root.querySelector('[name="categoryIds[]"][value="' + id + '"]');
          if (cb) cb.checked = true;
        });
        (entity.tagIds || []).forEach(function (id) {
          var cb = root.querySelector('[name="tagIds[]"][value="' + id + '"]');
          if (cb) cb.checked = true;
        });
        var authorEl = root.querySelector("[name=authorId]");
        if (authorEl && entity.authorId != null && entity.authorId !== "")
          authorEl.value = String(entity.authorId);
        var pin = root.querySelector("[name=pinned]");
        if (pin) pin.checked = !!entity.pinned;
      }
      ["status", "commentStatus"].forEach(function (name) {
        var el = root.querySelector("[name=" + name + "]");
        if (el && entity[name] != null && entity[name] !== "") el.value = String(entity[name]);
      });
      var pa = root.querySelector("[name=publishedAt]");
      if (pa && entity.publishedAt) pa.value = toLocalInput(entity.publishedAt);
    }

    var timer = null;
    root.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var p = window.__admEditor.entity;
        if (!p || p.status !== "draft") return;
        window.__admEditor.save().catch(function (e) { toast(e.message, "err"); });
      }, 2500);
    });
  }

  function markActiveNav() {
    var here = location.pathname.replace(/\/+$/, "") || "/admin";
    document.querySelectorAll(".adm-nav a").forEach(function (a) {
      var href = a.getAttribute("href");
      a.classList.toggle("is-active", href === here ||
        (href !== "/admin" && here.indexOf(href) === 0));
    });
  }

  function markBody() {
    document.documentElement.setAttribute("data-admin", "1");
    if (document.body) document.body.classList.add("adm-body");
    else document.addEventListener("DOMContentLoaded", function () {
      document.body.classList.add("adm-body");
    });
  }
  markBody();

  function hydrateControls() {
    document.querySelectorAll("textarea[data-dv]").forEach(function (ta) {
      if (!ta.__hydrated) { ta.value = ta.getAttribute("data-dv") || ""; ta.__hydrated = true; }
    });
    document.querySelectorAll("select[data-val]").forEach(function (sel) {
      sel.value = sel.getAttribute("data-val") || "";
    });
    document.querySelectorAll("input[type=checkbox][data-on]").forEach(function (cb) {
      cb.checked = cb.getAttribute("data-on") === "1";
    });
    applyShowIf();
  }

  function applyShowIf() {
    document.querySelectorAll("[data-show-if]").forEach(function (el) {
      var pair = (el.getAttribute("data-show-if") || "").split("=");
      var ctrl = document.getElementsByName(pair[0])[0];
      el.classList.toggle("is-shown", !!ctrl && ctrl.value === pair[1]);
    });
  }
  document.addEventListener("change", function (e) {
    if (e.target && e.target.tagName === "SELECT") applyShowIf();
  });

  function initWidgets() {
    markActiveNav();
    hydrateControls();
    initEditor();
  }

  function init() {
    if (document.body) document.body.classList.add("adm-body");
    initWidgets();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  function watchApp() {
    var el = document.getElementById("app") || document.body;
    if (!el) {
      document.addEventListener("DOMContentLoaded", watchApp);
      return;
    }
    new MutationObserver(function () { initWidgets(); }).observe(el, {
      childList: true, subtree: true,
    });
  }
  watchApp();
})();
