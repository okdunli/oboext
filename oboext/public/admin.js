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

  function initMedia() {
    var grid = document.querySelector("[data-media-grid]");
    if (!grid || grid.__bound) return;
    grid.__bound = true;

    var state = { items: [], selected: {} };
    try {
      state.items = JSON.parse(grid.getAttribute("data-media") || "{}").items || [];
    } catch (e) {}

    var form = document.querySelector("[data-media-upload-form]");
    var fileInput = document.querySelector("[data-media-file]");
    var dz = document.querySelector("[data-media-drop]");
    var dzText = document.querySelector("[data-media-dz-text]");
    var altInput = document.querySelector("[data-media-alt]");
    var submitBtn = document.querySelector("[data-media-submit]");
    var msgEl = document.querySelector("[data-media-msg]");
    var countEl = document.querySelector("[data-media-count]");
    var bulkBtn = document.querySelector("[data-media-bulk]");
    var allCb = document.querySelector("[data-media-all]");
    var emptyEl = document.querySelector("[data-media-empty]");
    var editModal = document.querySelector("[data-media-edit]");
    var editAlt = document.querySelector("[data-media-edit-alt]");
    var editName = document.querySelector("[data-media-edit-name]");
    var editImg = document.querySelector("[data-media-edit-img]");
    var preview = document.querySelector("[data-media-preview]");
    var prevImg = document.querySelector("[data-media-preview-img]");
    var prevOpen = document.querySelector("[data-media-preview-open]");
    var prevMeta = document.querySelector("[data-media-preview-meta]");
    var editing = null;

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function sizeText(n) {
      n = Number(n) || 0;
      if (n < 1024) return n + " B";
      if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
      return (n / 1048576).toFixed(1) + " MB";
    }
    function setMsg(t, ok) {
      if (!msgEl) return;
      msgEl.textContent = t;
      msgEl.className = "adm-media-msg " + (ok ? "is-ok" : "is-err");
    }
    function byId(id) {
      return state.items.filter(function (x) { return x.id === id; })[0] || null;
    }
    function selectedIds() {
      return Object.keys(state.selected).map(Number);
    }
    function syncSel() {
      var ids = selectedIds();
      if (countEl) countEl.textContent = "已选 " + ids.length + " / " + state.items.length;
      if (bulkBtn) bulkBtn.disabled = ids.length === 0;
      if (allCb) allCb.checked = state.items.length > 0 && ids.length === state.items.length;
    }
    function cardHtml(m) {
      var tile =
        String(m.mimeType).indexOf("image/") === 0
          ? '<img class="adm-media-thumb" src="' + esc(m.url) + '" alt="' + esc(m.alt || m.filename) +
            '" loading="lazy" data-media-preview-btn>'
          : '<div class="adm-media-file" data-media-preview-btn><span class="ic">📄</span><span>' +
            esc(m.mimeType) + "</span></div>";
      return (
        '<div class="adm-media-card" data-media-id="' + m.id + '">' +
        '<label class="adm-media-check"><input type="checkbox" class="adm-media-sel" value="' + m.id + '"' +
        (state.selected[m.id] ? " checked" : "") + "></label>" +
        tile +
        '<div class="adm-media-meta">' +
        '<p class="adm-media-name" title="' + esc(m.filename) + '">' + esc(m.filename) + "</p>" +
        '<p class="adm-hint">' + sizeText(m.size) + "</p>" +
        '<div class="adm-media-actions"><div class="row-actions">' +
        '<button type="button" class="adm-iconbtn" data-media-preview-btn title="查看 / 详情">🔍</button>' +
        '<button type="button" class="adm-iconbtn" data-media-copy data-url="' + esc(m.url) + '" title="复制链接">🔗</button>' +
        '<button type="button" class="adm-iconbtn" data-media-edit-btn title="编辑信息">✎</button>' +
        "</div>" +
        '<button type="button" class="adm-iconbtn danger" data-media-del data-url="/api/media/' + m.id +
        '" data-confirm="删除该媒体？此操作不可恢复。" title="删除">🗑</button>' +
        "</div></div></div>"
      );
    }
    function render() {
      grid.innerHTML = state.items.map(cardHtml).join("");
      if (emptyEl) emptyEl.classList.toggle("is-hidden", state.items.length > 0);
      syncSel();
    }
    async function load() {
      try {
        var d = await api("GET", "/api/media?limit=100");
        state.items = d.items || [];
        state.selected = {};
        render();
      } catch (e) {
        setMsg(e.message, false);
      }
    }
    async function copyLink(url, btn) {
      try {
        await navigator.clipboard.writeText(url);
        if (btn) {
          var old = btn.textContent;
          btn.textContent = "✓";
          setTimeout(function () { btn.textContent = old; }, 1500);
        }
      } catch (e) {
        toast("复制失败，请手动复制", "err");
      }
    }

    if (form) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var f = fileInput && fileInput.files[0];
        if (!f) return;
        submitBtn.disabled = true;
        var fd = new FormData();
        fd.append("file", f);
        if (altInput) fd.append("alt", altInput.value);
        try {
          var res = await fetch("/api/media", { method: "POST", body: fd });
          var data = null;
          try { data = await res.json(); } catch (err) {}
          if (!res.ok) throw new Error((data && data.error) || "上传失败 (" + res.status + ")");
          setMsg("上传成功", true);
          if (altInput) altInput.value = "";
          if (fileInput) fileInput.value = "";
          if (dzText) dzText.textContent = "点击选择文件，或拖拽到此处上传";
          await load();
        } catch (err) {
          setMsg(err.message, false);
        } finally {
          submitBtn.disabled = false;
        }
      });
    }
    if (dz && fileInput) {
      function pickName(f) {
        if (f && dzText) {
          dzText.textContent = f.name;
          submitBtn.disabled = false;
        }
      }
      dz.addEventListener("click", function () { fileInput.click(); });
      dz.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
      });
      ["dragenter", "dragover"].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("is-drag"); });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("is-drag"); });
      });
      dz.addEventListener("drop", function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) pickName(f);
      });
      fileInput.addEventListener("change", function () { pickName(fileInput.files[0]); });
    }

    grid.addEventListener("change", function (e) {
      if (!e.target.closest || !e.target.closest(".adm-media-sel")) return;
      var cb = e.target.closest(".adm-media-sel");
      var id = Number(cb.value);
      if (cb.checked) state.selected[id] = 1;
      else delete state.selected[id];
      syncSel();
    });
    grid.addEventListener("click", async function (e) {
      if (!e.target.closest) return;
      var del = e.target.closest("[data-media-del]");
      if (del) {
        e.preventDefault();
        if (!confirm(del.getAttribute("data-confirm") || "删除该媒体？此操作不可恢复。")) return;
        try {
          await api("DELETE", del.getAttribute("data-url"));
          await load();
          toast("已删除", "ok");
        } catch (err) { toast(err.message, "err"); }
        return;
      }
      var cp = e.target.closest("[data-media-copy]");
      if (cp) { copyLink(cp.getAttribute("data-url"), cp); return; }
      var eb = e.target.closest("[data-media-edit-btn]");
      if (eb) {
        openEdit(Number(eb.closest("[data-media-id]").getAttribute("data-media-id")));
        return;
      }
      var pb = e.target.closest("[data-media-preview-btn]");
      if (pb) {
        openPreview(Number(pb.closest("[data-media-id]").getAttribute("data-media-id")));
      }
    });

    if (allCb) {
      allCb.addEventListener("change", function () {
        var on = allCb.checked;
        state.items.forEach(function (m) {
          if (on) state.selected[m.id] = 1;
          else delete state.selected[m.id];
        });
        grid.querySelectorAll(".adm-media-sel").forEach(function (c) { c.checked = on; });
        syncSel();
      });
    }
    if (bulkBtn) {
      bulkBtn.addEventListener("click", async function () {
        var ids = selectedIds();
        if (!ids.length) return;
        if (!confirm("确认删除选中的 " + ids.length + " 个媒体？此操作不可恢复。")) return;
        bulkBtn.disabled = true;
        try {
          await api("DELETE", "/api/media?ids=" + ids.join(","));
          await load();
          toast("已删除 " + ids.length + " 个媒体", "ok");
        } catch (err) {
          toast(err.message, "err");
          bulkBtn.disabled = false;
        }
      });
    }

    function openEdit(id) {
      var m = byId(id);
      if (!m || !editModal) return;
      editing = m;
      editAlt.value = m.alt || "";
      editName.textContent = m.filename;
      if (editImg) {
        if (String(m.mimeType).indexOf("image/") === 0) {
          editImg.src = m.url;
          editImg.style.display = "";
        } else {
          editImg.removeAttribute("src");
          editImg.style.display = "none";
        }
      }
      editModal.hidden = false;
    }
    function closeEdit() {
      if (editModal) editModal.hidden = true;
      editing = null;
    }
    document.querySelectorAll("[data-media-edit-close]").forEach(function (b) {
      b.addEventListener("click", closeEdit);
    });
    var saveBtn = document.querySelector("[data-media-edit-save]");
    if (saveBtn) {
      saveBtn.addEventListener("click", async function () {
        if (!editing) return;
        try {
          var updated = await api("PATCH", "/api/media/" + editing.id, { alt: editAlt.value });
          var m = byId(editing.id);
          if (m) m.alt = updated.alt;
          render();
          closeEdit();
          toast("已更新", "ok");
        } catch (err) { toast(err.message, "err"); }
      });
    }

    function openPreview(id) {
      var m = byId(id);
      if (!m || !preview) return;
      var isImg = String(m.mimeType).indexOf("image/") === 0;
      if (prevImg) {
        if (isImg) { prevImg.src = m.url; prevImg.style.display = ""; }
        else { prevImg.removeAttribute("src"); prevImg.style.display = "none"; }
      }
      if (prevOpen) {
        prevOpen.href = m.url;
        prevOpen.style.display = isImg ? "none" : "";
      }
      if (prevMeta) {
        prevMeta.textContent = m.filename + " · " + m.mimeType + " · " + sizeText(m.size) +
          (m.alt ? " · " + m.alt : "");
      }
      preview.hidden = false;
    }
    function closePreview() { if (preview) preview.hidden = true; }
    document.querySelectorAll("[data-media-preview-close]").forEach(function (b) {
      b.addEventListener("click", closePreview);
    });
    if (preview) {
      preview.addEventListener("click", function (e) {
        if (e.target === preview) closePreview();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeEdit(); closePreview(); }
    });

    render();
  }

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

  function initMenus() {
    var root = document.querySelector("[data-menu-manager]");
    if (!root || root.__bound) return;
    root.__bound = true;

    var state = { menus: [], activeId: null, flat: [], options: {}, tempSeq: 0 };
    try {
      var boot = JSON.parse(root.getAttribute("data-menus") || "{}");
      state.menus = boot.menus || [];
      if (state.menus.length) state.activeId = state.menus[0].id;
    } catch (e) {}

    var tabsEl = root.querySelector("[data-menu-tabs]");
    var rowsEl = root.querySelector("[data-menu-rows]");
    var msgEl = root.querySelector("[data-menu-msg]");
    var emptyEl = root.querySelector("[data-menu-empty]");
    var saveBtn = root.querySelector("[data-menu-save]");
    var addBtn = root.querySelector("[data-menu-add]");

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function flatten(nodes, depth, parentId, out) {
      (nodes || []).forEach(function (n, i) {
        out.push({
          id: n.id, parentId: parentId, order: i,
          type: n.type || "custom", label: n.label || "", url: n.url || "",
          referenceSlug: n.referenceSlug || "", target: n.target || "_self",
          icon: n.icon || "", depth: depth,
        });
        if (n.children && n.children.length)
          flatten(n.children, depth + 1, n.id, out);
      });
      return out;
    }
    function activeMenu() {
      return state.menus.filter(function (m) { return m.id === state.activeId; })[0] || null;
    }
    function useMenu(id) {
      state.activeId = id;
      var m = activeMenu();
      state.flat = m ? flatten(m.items, 0, null, []) : [];
      render();
      var types = [];
      state.flat.forEach(function (it) {
        if (it.type !== "custom" && types.indexOf(it.type) < 0) types.push(it.type);
      });
      types.forEach(ensureOptions);
    }
    function setMsg(t, ok) {
      if (!msgEl) return;
      msgEl.textContent = t;
      msgEl.className = "adm-menu-msg" + (t ? (ok ? " is-ok" : " is-err") : "");
    }
    function tabHtml(m) {
      return '<button type="button" class="adm-menu-tab' +
        (m.id === state.activeId ? " is-active" : "") +
        '" data-menu-tab data-id="' + m.id + '">' + esc(m.name) +
        ' <span class="adm-menu-loc">(' + esc(m.location) + ")</span></button>";
    }
    function refOptions(it) {
      var list = state.options[it.type] || [];
      var have = list.some(function (o) { return o.slug === it.referenceSlug; });
      var html = '<option value="">' +
        ("选择" + ({ post: "文章", page: "页面", category: "分类", tag: "标签" })[it.type] || "目标") + "…</option>";
      if (it.referenceSlug && !have)
        html += '<option value="' + esc(it.referenceSlug) + '">' + esc(it.label || it.referenceSlug) + "</option>";
      list.forEach(function (o) {
        html += '<option value="' + esc(o.slug) + '"' + (o.slug === it.referenceSlug ? " selected" : "") +
          ">" + esc(o.label) + "</option>";
      });
      return html;
    }
    function rowHtml(it, idx) {
      var html = '<div class="adm-menu-row" data-menu-row style="margin-left:' + (it.depth * 20) + 'px">';
      html += '<span class="adm-menu-depth">L' + (it.depth + 1) + "</span>";
      html += '<select class="adm-select adm-menu-type" data-f="type">';
      ["custom", "post", "page", "category", "tag"].forEach(function (t) {
        var label = { custom: "自定义链接", post: "文章", page: "页面", category: "分类", tag: "标签" }[t];
        html += '<option value="' + t + '"' + (it.type === t ? " selected" : "") + ">" + label + "</option>";
      });
      html += "</select>";
      if (it.type !== "custom") {
        html += '<select class="adm-select adm-menu-ref" data-f="ref">' + refOptions(it) + "</select>";
      }
      html += '<input class="adm-input adm-menu-label" data-f="label" value="' + esc(it.label) + '" placeholder="显示文字">';
      if (it.type === "custom") {
        html += '<input class="adm-input adm-menu-url" data-f="url" value="' + esc(it.url) + '" placeholder="链接 /">';
      } else {
        html += '<span class="adm-menu-mono" title="' + esc(it.url) + '">' +
          esc(it.referenceSlug ? (it.url || "已选择") : "未选择") + "</span>";
      }
      html += '<input class="adm-input adm-menu-icon" data-f="icon" value="' + esc(it.icon) +
        '" placeholder="图标标识" title="图标标识（lucide 名称，如 house）">';
      html += '<div class="adm-menu-tools">';
      html += '<button type="button" class="adm-iconbtn" data-menu-act="up" title="上移" ' +
        (idx === 0 ? "disabled" : "") + ">↑</button>";
      html += '<button type="button" class="adm-iconbtn" data-menu-act="down" title="下移" ' +
        (idx === state.flat.length - 1 ? "disabled" : "") + ">↓</button>";
      html += '<button type="button" class="adm-iconbtn" data-menu-act="indent" title="作为上一项的子项" ' +
        (idx === 0 ? "disabled" : "") + ">↳</button>";
      if (it.depth > 0)
        html += '<button type="button" class="adm-iconbtn" data-menu-act="outdent" title="升回顶级">↰</button>';
      html += '<button type="button" class="adm-iconbtn danger" data-menu-act="del" title="删除">🗑</button>';
      html += "</div></div>";
      return html;
    }
    function render() {
      if (tabsEl) tabsEl.innerHTML = state.menus.map(tabHtml).join("");
      if (rowsEl) rowsEl.innerHTML = state.flat.map(rowHtml).join("");
      if (emptyEl) emptyEl.classList.toggle("is-hidden", state.flat.length > 0);
      if (saveBtn) saveBtn.disabled = state.activeId == null;
    }
    function ensureOptions(type) {
      if (state.options[type] || type === "custom") return Promise.resolve();
      var url = type === "post" ? "/api/posts?status=published&limit=100"
        : type === "page" ? "/api/pages?status=published&limit=100"
        : type === "category" ? "/api/categories" : "/api/tags";
      return api("GET", url).then(function (data) {
        var list;
        if (type === "post" || type === "page") {
          list = (data.items || []).map(function (p) {
            return { id: p.id, label: p.title, slug: p.slug, url: p.url || "" };
          });
        } else {
          list = (data || []).map(function (t) {
            return { id: t.id, label: t.name, slug: t.slug, url: t.url || "" };
          });
        }
        state.options[type] = list;
        render();
      }).catch(function () { state.options[type] = []; });
    }

    tabsEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-menu-tab]");
      if (b) useMenu(Number(b.getAttribute("data-id")));
    });
    addBtn.addEventListener("click", function () {
      var id = --state.tempSeq;
      state.flat.push({
        id: id, parentId: null, order: state.flat.length, type: "custom",
        label: "", url: "", referenceSlug: "", target: "_self", icon: "", depth: 0,
      });
      render();
    });

    rowsEl.addEventListener("change", function (e) {
      var row = e.target.closest("[data-menu-row]");
      if (!row) return;
      var idx = [].slice.call(rowsEl.children).indexOf(row);
      var it = state.flat[idx];
      var f = e.target.getAttribute("data-f");
      if (f === "type") {
        it.type = e.target.value;
        it.referenceSlug = "";
        it.url = "";
        render();
        ensureOptions(it.type);
        return;
      }
      if (f === "ref") {
        var slug = e.target.value;
        var matched = (state.options[it.type] || []).filter(function (o) { return o.slug === slug; })[0];
        it.referenceSlug = slug || null;
        it.url = matched ? matched.url : "";
        if (matched) it.label = matched.label;
        render();
      }
    });
    rowsEl.addEventListener("input", function (e) {
      var row = e.target.closest("[data-menu-row]");
      if (!row) return;
      var idx = [].slice.call(rowsEl.children).indexOf(row);
      var it = state.flat[idx];
      var f = e.target.getAttribute("data-f");
      if (f === "label") it.label = e.target.value;
      else if (f === "url") it.url = e.target.value;
      else if (f === "icon") it.icon = e.target.value;
    });
    rowsEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-menu-act]");
      if (!b) return;
      var row = e.target.closest("[data-menu-row]");
      var idx = [].slice.call(rowsEl.children).indexOf(row);
      var it = state.flat[idx];
      var act = b.getAttribute("data-menu-act");
      if (act === "up" && idx > 0) {
        var t1 = state.flat[idx - 1];
        state.flat[idx - 1] = it; state.flat[idx] = t1;
      } else if (act === "down" && idx < state.flat.length - 1) {
        var t2 = state.flat[idx + 1];
        state.flat[idx + 1] = it; state.flat[idx] = t2;
      } else if (act === "indent" && idx > 0) {
        var prev = state.flat[idx - 1];
        if (prev.id !== undefined) { it.parentId = prev.id; it.depth = Math.min(prev.depth + 1, 2); }
      } else if (act === "outdent") {
        it.parentId = null; it.depth = 0;
      } else if (act === "del") {
        state.flat = state.flat.filter(function (x, i) {
          return i !== idx && x.parentId !== it.id;
        });
      }
      render();
    });

    saveBtn.addEventListener("click", async function () {
      if (state.activeId == null) return;
      for (var i = 0; i < state.flat.length; i++) {
        if (!state.flat[i].label.trim()) {
          setMsg("第 " + (i + 1) + " 项缺少显示文字", false);
          return;
        }
      }
      var payload = {
        items: state.flat.map(function (it, i) {
          return {
            id: it.id, parentId: it.parentId, order: i, type: it.type,
            label: it.label, url: it.url, referenceSlug: it.referenceSlug || null,
            target: it.target, icon: it.icon || null,
          };
        }),
      };
      saveBtn.disabled = true;
      try {
        await api("PUT", "/api/menus/" + state.activeId, payload);
        setMsg("已保存 ✓", true);
        var data = await api("GET", "/api/menus");
        state.menus = data || [];
        useMenu(state.activeId);
      } catch (err) {
        setMsg(err.message, false);
      } finally {
        saveBtn.disabled = false;
      }
    });

    render();
    if (state.activeId != null) useMenu(state.activeId);
  }

  function initImageFields() {
    document.querySelectorAll("[data-img-field]").forEach(function (box) {
      if (box.__bound) return;
      box.__bound = true;
      var input = box.querySelector("input.adm-input");
      var file = box.querySelector("[data-img-file]");
      var prev = box.querySelector("[data-img-preview]");
      var err = box.querySelector("[data-img-err]");
      var btn = box.querySelector("[data-img-btn]");
      function sync() {
        if (prev) prev.src = (input.value || "").trim();
      }
      input.addEventListener("input", sync);
      file.addEventListener("change", async function () {
        var f = file.files && file.files[0];
        file.value = "";
        if (!f) return;
        if (btn) btn.classList.add("is-busy");
        if (err) err.textContent = "";
        try {
          var fd = new FormData();
          fd.append("file", f);
          var res = await fetch("/api/media", { method: "POST", body: fd });
          var data = {};
          try { data = await res.json(); } catch (e) {}
          if (!res.ok) throw new Error(data.error || "上传失败 (" + res.status + ")");
          input.value = data.url || data.path || data.src || "";
          sync();
        } catch (e) {
          if (err) err.textContent = e.message;
        } finally {
          if (btn) btn.classList.remove("is-busy");
        }
      });
      sync();
    });
  }

  function initWidgetManager() {
    var root = document.querySelector("[data-wg-manager]");
    if (!root || root.__wgbound) return;
    root.__wgbound = true;

    var boot = {};
    try { boot = JSON.parse(root.getAttribute("data-wg") || "{}"); } catch (e) { return; }
    var theme = boot.theme || "skyscraper";
    var typeMap = {};
    (boot.types || []).forEach(function (t) { typeMap[t.type] = t; });
    var byId = {};
    (boot.widgets || []).forEach(function (w) { byId[w.id] = w; });

    var themeSel = root.querySelector("[data-wg-theme]");
    if (themeSel && !themeSel.__wgBound) {
      themeSel.__wgBound = true;
      themeSel.value = boot.theme || themeSel.value;
      themeSel.addEventListener("change", function () {
        location.search = "?theme=" + encodeURIComponent(themeSel.value);
      });
    }

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function reloadSoon() { setTimeout(function () { location.reload(); }, 250); }
    function fail(err) { toast(err.message || "请求失败", "err"); }

    root.addEventListener("click", function (e) {
      var b;
      if ((b = e.target.closest("[data-wg-add-open]"))) {
        var sec = b.closest(".adm-wg-area");
        var picker = sec.querySelector("[data-wg-picker]");
        if (picker) picker.hidden = false;
        b.hidden = true;
        return;
      }
      if ((b = e.target.closest("[data-wg-picker-x]"))) {
        var sec2 = b.closest(".adm-wg-area");
        sec2.querySelector("[data-wg-picker]").hidden = true;
        var openBtn = sec2.querySelector("[data-wg-add-open]");
        if (openBtn) openBtn.hidden = false;
        return;
      }
      if ((b = e.target.closest("[data-wg-add]"))) {
        var area = b.getAttribute("data-wg-area");
        var type = b.getAttribute("data-type");
        var def = typeMap[type] || {};
        api("POST", "/api/widgets", { area: area, type: type, themeSlug: theme, title: def.label || "" })
          .then(function () { toast("已添加", "ok"); reloadSoon(); }).catch(fail);
        return;
      }
      if ((b = e.target.closest("[data-wg-move]"))) {
        if (b.classList.contains("is-disabled")) return;
        var rowEl = b.closest("[data-wg-id]");
        var box = rowEl.parentElement;
        var ids = [].slice.call(box.querySelectorAll("[data-wg-id]"))
          .map(function (r) { return Number(r.getAttribute("data-wg-id")); });
        var i = ids.indexOf(Number(rowEl.getAttribute("data-wg-id")));
        var j = i + Number(b.getAttribute("data-wg-move"));
        if (i < 0 || j < 0 || j >= ids.length) return;
        var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
        api("PATCH", "/api/widgets", { ids: ids }).then(reloadSoon).catch(fail);
        return;
      }
      if ((b = e.target.closest("[data-wg-toggle]"))) {
        var w0 = byId[Number(b.closest("[data-wg-id]").getAttribute("data-wg-id"))];
        api("PATCH", "/api/widgets/" + w0.id, { enabled: !w0.enabled }).then(reloadSoon).catch(fail);
        return;
      }
      if ((b = e.target.closest("[data-wg-del]"))) {
        var id = Number(b.closest("[data-wg-id]").getAttribute("data-wg-id"));
        if (!confirm("确定删除这个小工具？")) return;
        api("DELETE", "/api/widgets/" + id)
          .then(function () { toast("已删除", "ok"); reloadSoon(); }).catch(fail);
        return;
      }
      if ((b = e.target.closest("[data-wg-edit]"))) {
        var ew = byId[Number(b.closest("[data-wg-id]").getAttribute("data-wg-id"))];
        openEditor(ew);
      }
    });

    var modal = null;
    var editing = null;
    var fields = [];

    function allFields(def) {
      return (def.settings || []).reduce(function (a, s) { return a.concat(s.fields || []); }, []);
    }
    function resolveValues(flds, stored) {
      var out = {};
      flds.forEach(function (f) { if (f.default !== undefined) out[f.key] = f.default; });
      var known = {};
      flds.forEach(function (f) { known[f.key] = 1; });
      Object.keys(stored || {}).forEach(function (k) {
        var v = stored[k];
        if (known[k] && v !== undefined && v !== null && v !== "") out[k] = v;
      });
      return out;
    }
    function fieldHtml(f, values) {
      var v = values[f.key];
      var showIf = f.showIf
        ? ' data-showif-key="' + esc(f.showIf.key) + '" data-showif-eq="' +
          esc([].concat(f.showIf.equals).map(String).join(",")) + '"'
        : "";
      var html = '<div class="adm-wg-fld' + (f.half ? " half" : "") +
        '" data-wg-fld="' + esc(f.key) + '"' + showIf + ">";
      if (f.type === "switch") {
        html += '<button type="button" class="adm-wg-switch"><span>' + esc(f.label) + "</span>" +
          '<span class="track' + (v ? " is-on" : "") + '"><i></i></span></button>';
      } else {
        html += '<label class="adm-wg-label">' + esc(f.label) + "</label>";
        if (f.type === "number") {
          html += '<input class="adm-input" type="number" data-wg-input' +
            (f.min != null ? ' min="' + f.min + '"' : "") +
            (f.max != null ? ' max="' + f.max + '"' : "") + ' value="' + esc(Number(v) || 0) + '">';
        } else if (f.type === "select") {
          html += '<select class="adm-select" data-wg-input>' +
            (f.options || []).map(function (o) {
              return '<option value="' + esc(o.value) + '"' +
                (String(o.value) === String(v) ? " selected" : "") + ">" + esc(o.label) + "</option>";
            }).join("") + "</select>";
        } else if (f.type === "textarea" || f.type === "code") {
          html += '<textarea class="adm-textarea' + (f.type === "code" ? " adm-wg-code" : "") +
            '" rows="' + (f.type === "code" ? 8 : 3) + '" data-wg-input placeholder="' +
            esc(f.placeholder || "") + '">' + esc(v) + "</textarea>";
        } else if (f.type === "image") {
          html += '<div class="adm-wg-img">' +
            '<img class="adm-wg-img-prev" data-wg-img-prev alt="" src="' + esc(v || "") + '">' +
            '<div class="adm-wg-img-row"><input class="adm-input" data-wg-input placeholder="/uploads/media/... 或 https://..." value="' + esc(v || "") + '">' +
            '<label class="adm-imgfield-btn">⬆ 上传<input type="file" accept="image/*" class="adm-hidden-file" data-wg-img-file></label>' +
            "</div></div>";
        } else if (f.type === "links") {
          var rows = Array.isArray(v) ? v : [];
          html += '<div class="adm-wg-links" data-wg-links>' +
            rows.map(function (it) {
              return '<div class="adm-wg-link-row">' +
                '<input class="adm-input" data-wg-link="label" placeholder="名称" value="' + esc(it.label || "") + '">' +
                '<input class="adm-input" data-wg-link="url" placeholder="https://" value="' + esc(it.url || "") + '">' +
                '<input class="adm-input" data-wg-link="icon" placeholder="图标" value="' + esc(it.icon || "") + '">' +
                '<button type="button" class="adm-iconbtn danger" data-wg-link-del title="删除">🗑</button></div>';
            }).join("") +
            '<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-wg-link-add>＋ 添加一项</button></div>';
        } else {
          html += '<input class="adm-input" data-wg-input placeholder="' + esc(f.placeholder || "") +
            '" value="' + esc(v == null ? "" : v) + '">';
        }
      }
      if (f.help) html += '<p class="adm-hint">' + esc(f.help) + "</p>";
      return html + "</div>";
    }
    function linkRowHtml(it) {
      it = it || {};
      return '<div class="adm-wg-link-row">' +
        '<input class="adm-input" data-wg-link="label" placeholder="名称" value="' + esc(it.label || "") + '">' +
        '<input class="adm-input" data-wg-link="url" placeholder="https://" value="' + esc(it.url || "") + '">' +
        '<input class="adm-input" data-wg-link="icon" placeholder="图标" value="' + esc(it.icon || "") + '">' +
        '<button type="button" class="adm-iconbtn danger" data-wg-link-del title="删除">🗑</button></div>';
    }
    function liveValue(f) {
      var box = modal.querySelector('[data-wg-fld="' + f.key + '"]');
      if (!box) return undefined;
      if (f.type === "switch")
        return !!box.querySelector(".track.is-on");
      if (f.type === "links") {
        return [].slice.call(box.querySelectorAll(".adm-wg-link-row")).map(function (r) {
          return {
            label: r.querySelector('[data-wg-link="label"]').value,
            url: r.querySelector('[data-wg-link="url"]').value,
            icon: r.querySelector('[data-wg-link="icon"]').value,
          };
        });
      }
      var inp = box.querySelector("[data-wg-input]");
      if (f.type === "number") {
        var n = Number(inp.value);
        return Number.isFinite(n) ? n : (f.default === undefined ? 0 : f.default);
      }
      return inp.value;
    }
    function applyShowIf() {
      modal.querySelectorAll("[data-showif-key]").forEach(function (box) {
        var key = box.getAttribute("data-showif-key");
        var eq = box.getAttribute("data-showif-eq").split(",");
        var f = fields.filter(function (x) { return x.key === key; })[0];
        var cur = f ? String(liveValue(f)) : "";
        box.hidden = eq.indexOf(cur) < 0;
      });
    }
    function ensureModal() {
      if (modal) return modal;
      modal = document.createElement("div");
      modal.className = "adm-modal";
      modal.hidden = true;
      modal.innerHTML =
        '<div class="adm-modal-box adm-wg-modal-box">' +
        '<div class="adm-modal-hd"><div><h2 data-wg-modal-title></h2>' +
        '<p class="adm-wg-modal-sub" data-wg-modal-sub></p></div>' +
        '<button class="adm-modal-x" data-wg-modal-x>✕</button></div>' +
        '<div class="adm-modal-bd">' +
        '<label class="adm-wg-label">标题</label>' +
        '<input class="adm-input" data-wg-title placeholder="留空则不显示标题">' +
        '<div class="adm-wg-form" data-wg-form></div></div>' +
        '<div class="adm-modal-ft">' +
        '<button class="adm-btn adm-btn-ghost" data-wg-modal-cancel>取消</button>' +
        '<button class="adm-btn" data-wg-save>保存</button></div></div>';
      document.body.appendChild(modal);

      modal.addEventListener("click", function (e) {
        if (e.target === modal || e.target.closest("[data-wg-modal-x]") ||
            e.target.closest("[data-wg-modal-cancel]")) {
          modal.hidden = true;
        }
        var sw = e.target.closest("[data-wg-switch]");
        if (sw) {
          sw.querySelector(".track").classList.toggle("is-on");
          applyShowIf();
          return;
        }
        if (e.target.closest("[data-wg-link-add]")) {
          var holder = e.target.closest("[data-wg-links]");
          var addBtn = holder.querySelector("[data-wg-link-add]");
          addBtn.insertAdjacentHTML("beforebegin", linkRowHtml({}));
          return;
        }
        var delLink = e.target.closest("[data-wg-link-del]");
        if (delLink) {
          delLink.closest(".adm-wg-link-row").remove();
        }
      });
      modal.addEventListener("input", function (e) {
        if (e.target.hasAttribute && e.target.hasAttribute("data-wg-input")) {
          var imgBox = e.target.closest(".adm-wg-img");
          if (imgBox) imgBox.querySelector("[data-wg-img-prev]").src = e.target.value;
          applyShowIf();
        }
      });
      modal.addEventListener("change", function (e) {
        var file = e.target.hasAttribute && e.target.getAttribute("data-wg-img-file");
        if (!file) { applyShowIf(); return; }
        var f0 = e.target.files && e.target.files[0];
        e.target.value = "";
        if (!f0) return;
        var btn = e.target.parentElement;
        btn.classList.add("is-busy");
        var fd = new FormData();
        fd.append("file", f0);
        fetch("/api/media", { method: "POST", body: fd })
          .then(async function (res) {
            var data = {};
            try { data = await res.json(); } catch (err) {}
            if (!res.ok) throw new Error(data.error || "上传失败 (" + res.status + ")");
            var url = data.url || data.path || data.src || "";
            var imgBox = e.target.closest(".adm-wg-img");
            imgBox.querySelector("[data-wg-input]").value = url;
            imgBox.querySelector("[data-wg-img-prev]").src = url;
          })
          .catch(fail)
          .finally(function () { btn.classList.remove("is-busy"); });
      });
      modal.querySelector("[data-wg-save]").addEventListener("click", async function () {
        if (!editing) return;
        var config = {};
        fields.forEach(function (f) {
          var v = liveValue(f);
          if (v !== undefined) config[f.key] = v;
        });
        var title = modal.querySelector("[data-wg-title]").value;
        var saveBtn = modal.querySelector("[data-wg-save]");
        saveBtn.disabled = true;
        try {
          await api("PATCH", "/api/widgets/" + editing.id, { title: title, config: config });
          modal.hidden = true;
          toast("已保存", "ok");
          reloadSoon();
        } catch (err) {
          fail(err);
        } finally {
          saveBtn.disabled = false;
        }
      });
      return modal;
    }
    function openEditor(w) {
      var def = typeMap[w.type] || { settings: [] };
      editing = w;
      fields = allFields(def);
      var values = resolveValues(fields, w.config || {});
      ensureModal();
      modal.querySelector("[data-wg-modal-title]").textContent = def.label || w.type;
      modal.querySelector("[data-wg-modal-sub]").textContent = w.area + " · " + w.type;
      modal.querySelector("[data-wg-title]").value = w.title || "";
      var form = modal.querySelector("[data-wg-form]");
      form.innerHTML = fields.map(function (f) { return fieldHtml(f, values); }).join("");
      applyShowIf();
      modal.hidden = false;
    }
  }

  function initMenuSettings() {
    var root = document.querySelector("[data-ms-manager]");
    if (!root || root.__msbound) return;
    root.__msbound = true;
    var msgEl = root.querySelector("[data-ms-msg]");
    var saveBtn = root.querySelector("[data-ms-save]");

    function setMsg(kind, text) {
      if (!msgEl) return;
      msgEl.textContent = text || "";
      msgEl.className = "adm-ms-msg" + (kind === "err" ? " is-err" : kind === "ok" ? " is-ok" : "");
    }

    root.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-ms-home]");
      if (!btn || !root.contains(btn)) return;
      var row = btn.closest("[data-ms-row]");
      if (!row || row.dataset.canhome !== "1") return;
      var cur = root.querySelector('[data-ms-row][data-home="1"]');
      if (cur && cur !== row) {
        cur.dataset.home = "0";
        cur.classList.remove("is-home");
        var oldCb = cur.querySelector("[data-ms-check]");
        if (cur.dataset.locked !== "1") {
          oldCb.dataset.disabled = "0";
          oldCb.disabled = false;
        }
      }
      row.dataset.home = "1";
      row.dataset.hidden = "0";
      row.classList.remove("is-hidden");
      row.classList.add("is-home");
      var cb = row.querySelector("[data-ms-check]");
      cb.dataset.disabled = "1";
      cb.disabled = true;
      cb.checked = true;
      cb.dataset.on = "1";
      setMsg("", "");
    });

    root.addEventListener("change", function (e) {
      var cb = e.target.closest && e.target.closest("[data-ms-check]");
      if (!cb || !root.contains(cb)) return;
      var row = cb.closest("[data-ms-row]");
      if (cb.dataset.disabled === "1") {
        cb.checked = row.dataset.hidden !== "1";
        return;
      }
      var hidden = !cb.checked;
      row.dataset.hidden = hidden ? "1" : "0";
      row.classList.toggle("is-hidden", hidden);
      cb.dataset.on = hidden ? "0" : "1";
    });

    saveBtn.addEventListener("click", async function () {
      var hidden = [];
      root.querySelectorAll("[data-ms-row]").forEach(function (r) {
        if (r.dataset.hidden === "1" && r.dataset.home !== "1" && r.dataset.locked !== "1") {
          hidden.push(r.dataset.msRow);
        }
      });
      var homeRow = root.querySelector('[data-ms-row][data-home="1"]');
      var homePath = homeRow ? homeRow.dataset.msRow : "/admin";
      saveBtn.disabled = true;
      try {
        await api("POST", "/api/admin/menu-settings", {
          hiddenHrefs: hidden,
          homePath: homePath,
        });
        toast("已保存，侧栏菜单已更新");
        setTimeout(function () { location.reload(); }, 300);
      } catch (err) {
        setMsg("err", (err && err.message) || "保存失败");
        saveBtn.disabled = false;
      }
    });
  }

  function initThemeManager() {
    var root = document.querySelector("[data-th-manager]");
    if (!root || root.__thbound) return;
    root.__thbound = true;
    var boot = {};
    try { boot = JSON.parse(root.getAttribute("data-th") || "{}"); } catch (e) { return; }

    function list() { return boot.themes || []; }
    function activeTheme() {
      return list().filter(function (t) { return t.active; })[0] || list()[0] || null;
    }
    function reloadSoon() { setTimeout(function () { location.reload(); }, 450); }
    function fail(err) { toast(err.message || "请求失败", "err"); }

    root.addEventListener("click", function (e) {
      var b;
      if ((b = e.target.closest("[data-th-create]"))) {
        e.preventDefault();
        var input = root.querySelector("[data-th-new-name]");
        var name = (input.value || "").trim();
        if (!name) return toast("请输入主题名称");
        var base = activeTheme();
        b.disabled = true;
        api("POST", "/api/themes", { name: name, config: base ? base.config : {} })
          .then(function (row) {
            toast("已创建", "ok");
            location.href = "/admin/themes/" + row.slug;
          })
          .catch(function (err) { fail(err); b.disabled = false; });
        return;
      }
      if ((b = e.target.closest("[data-th-activate]"))) {
        var card = b.closest("[data-th-id]");
        var slug = card.getAttribute("data-th-slug");
        api("PATCH", "/api/settings", { activeThemeSlug: slug })
          .then(function () { toast("已启用", "ok"); reloadSoon(); }).catch(fail);
        return;
      }
      if ((b = e.target.closest("[data-th-delete]"))) {
        var id = b.closest("[data-th-id]").getAttribute("data-th-id");
        if (!confirm("确定删除该主题？其主题文件夹也会被删除。")) return;
        api("DELETE", "/api/themes/" + id)
          .then(function () { toast("已删除", "ok"); reloadSoon(); }).catch(fail);
      }
    });

    root.addEventListener("change", function (e) {
      if (!(e.target.hasAttribute && e.target.hasAttribute("data-th-zip"))) return;
      var f0 = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f0) return;
      var box = root.querySelector("[data-th-upload]");
      var msg = box.querySelector(".adm-th-upload-msg");
      var btn = box.querySelector(".adm-th-upload-btn");
      btn.classList.add("is-busy");
      msg.className = "adm-th-upload-msg";
      msg.textContent = "正在上传安装…";
      var fd = new FormData();
      fd.append("file", f0);
      fetch("/api/themes/upload", { method: "POST", body: fd })
        .then(async function (res) {
          var data = {};
          try { data = await res.json(); } catch (err) {}
          if (!res.ok) throw new Error(data.error || "安装失败 (" + res.status + ")");
          msg.classList.add("is-ok");
          msg.textContent = "安装成功";
          toast("主题已安装", "ok");
          reloadSoon();
        })
        .catch(function (err) {
          msg.classList.add("is-err");
          msg.textContent = err.message;
        })
        .finally(function () { btn.classList.remove("is-busy"); });
    });
  }

  function initThemePanel() {
    var root = document.querySelector("[data-th-panel]");
    if (!root || root.__thpbound) return;
    root.__thpbound = true;
    var panel;
    try { panel = JSON.parse(root.getAttribute("data-th-panel-data") || "{}"); } catch (e) { return; }
    if (!panel.theme) return;

    var appearance = panel.appearanceSchema || [];
    var own = panel.settingsSchema || [];
    var allSections = appearance.concat(own);
    var fields = allSections.reduce(function (a, s) { return a.concat(s.fields || []); }, []);
    var draft = Object.assign({}, panel.config || {}, panel.settings || {});
    var activeKey = (appearance[0] && appearance[0].key) || (own[0] && own[0].key) || "";
    var catsCache = null;
    var catOptions = [];

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function fieldVisible(f) {
      if (!f.showIf) return true;
      var cur = String(draft[f.showIf.key] == null ? "" : draft[f.showIf.key]);
      var eq = [].concat(f.showIf.equals).map(String);
      return eq.indexOf(cur) >= 0;
    }

    function switchTrack(on) {
      return '<span class="track' + (on ? " is-on" : "") + '"><i></i></span>';
    }

    function fieldHtml(f) {
      var v = draft[f.key];
      var show = fieldVisible(f) ? "" : " hidden";
      var half = f.half ? " half" : "";
      var html = '<div class="adm-thp-fld' + half + '" data-fld="' + esc(f.key) + '"' + show + ">";
      if (f.type === "group") {
        return '<div class="adm-thp-group" data-fld="' + esc(f.key) + '">' +
          '<p>' + esc(f.label) + "</p>" +
          (f.help ? '<p class="adm-thp-help">' + esc(f.help) + "</p>" : "") + "</div>";
      }
      if (f.type === "switch") {
        html += '<button type="button" class="adm-wg-switch" data-k="' + esc(f.key) + '" data-t="switch">' +
          "<span>" + esc(f.label) + "</span>" + switchTrack(!!v) + "</button>";
        if (f.help) html += '<p class="adm-thp-help">' + esc(f.help) + "</p>";
        return html + "</div>";
      }
      html += '<label class="adm-thp-label">' + esc(f.label) + "</label>";
      if (f.type === "color") {
        var hex = /^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v) : "#000000";
        html += '<div class="adm-thp-color"><input type="color" class="adm-thp-colorpick" data-k="' +
          esc(f.key) + '" data-t="color" value="' + hex + '">' +
          '<input class="adm-input adm-thp-monospace" data-k="' + esc(f.key) +
          '" data-t="text" value="' + esc(v == null ? "" : v) +
          '" placeholder="' + esc(f.placeholder || "#000000 / rgba() / gradient") + '"></div>';
      } else if (f.type === "select") {
        html += '<select class="adm-select" data-k="' + esc(f.key) + '" data-t="select">' +
          (f.options || []).map(function (o) {
            return '<option value="' + esc(o.value) + '"' +
              (String(o.value) === String(v == null ? "" : v) ? " selected" : "") + ">" +
              esc(o.label) + "</option>";
          }).join("") + "</select>";
      } else if (f.type === "range") {
        var num = Number(v == null ? f.default || 0 : v) || 0;
        html += '<div class="adm-thp-range"><input type="range" data-k="' + esc(f.key) +
          '" data-t="range" min="' + (f.min != null ? f.min : 0) + '" max="' +
          (f.max != null ? f.max : 100) + '" step="' + (f.step != null ? f.step : 1) +
          '" value="' + num + '"><span class="adm-thp-range-val" data-range-val="' +
          esc(f.key) + '">' + esc(String(v == null ? f.default || 0 : v)) + esc(f.unit || "") +
          "</span></div>";
      } else if (f.type === "number") {
        html += '<input class="adm-input" type="number" data-k="' + esc(f.key) +
          '" data-t="number"' + (f.min != null ? ' min="' + f.min + '"' : "") +
          (f.max != null ? ' max="' + f.max + '"' : "") +
          ' value="' + esc(Number(v == null ? f.default || 0 : v) || 0) + '">';
      } else if (f.type === "textarea" || f.type === "code") {
        html += '<textarea class="adm-textarea' + (f.type === "code" ? " adm-thp-code" : "") +
          '" rows="' + (f.type === "code" ? 9 : 3) + '" data-k="' + esc(f.key) +
          '" data-t="text" placeholder="' + esc(f.placeholder || "") + '">' +
          esc(v == null ? "" : v) + "</textarea>";
      } else if (f.type === "image") {
        var u = String(v || "");
        html += '<div class="adm-wg-img"><img class="adm-wg-img-prev" alt="" src="' + esc(u) + '">' +
          '<div class="adm-wg-img-row"><input class="adm-input" data-k="' + esc(f.key) +
          '" data-t="text" placeholder="/uploads/media/... 或 https://..." value="' + esc(u) + '">' +
          '<label class="adm-imgfield-btn">⬆ 上传<input type="file" accept="image/*" class="adm-hidden-file" data-img-key="' +
          esc(f.key) + '"></label></div></div>';
      } else if (f.type === "links") {
        var items = Array.isArray(v) ? v : [];
        html += '<div class="adm-wg-links" data-repeat="links" data-k="' + esc(f.key) + '">' +
          items.map(linkRowHtml).join("") +
          '<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-repeat-add>＋ 添加一项</button></div>';
      } else if (f.type === "categoryRows") {
        var cats = Array.isArray(v) ? v : [];
        html += '<div class="adm-thp-cats" data-repeat="cats" data-k="' + esc(f.key) + '">' +
          cats.map(function (it) { return catRowHtml(it, ""); }).join("") +
          '<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-repeat-add>＋ 添加分类区块</button>' +
          '<p class="adm-thp-cats-state">正在加载分类…</p></div>';
        loadCats();
      } else {
        var isFont = f.type === "font";
        html += '<input class="adm-input' + (isFont ? " adm-thp-monospace" : "") +
          '" data-k="' + esc(f.key) + '" data-t="text" value="' +
          esc(v == null ? "" : v) + '" placeholder="' + esc(f.placeholder || "") + '"' +
          (isFont ? ' style="font-family:' + esc(v || "inherit") + '"' : "") + ">";
      }
      if (f.help) html += '<p class="adm-thp-help">' + esc(f.help) + "</p>";
      return html + "</div>";
    }

    function linkRowHtml(it) {
      it = it || {};
      return '<div class="adm-wg-link-row" data-repeat-row>' +
        '<input class="adm-input" data-rk="label" placeholder="名称" value="' + esc(it.label || "") + '">' +
        '<input class="adm-input" data-rk="url" placeholder="https://" value="' + esc(it.url || "") + '">' +
        '<input class="adm-input" data-rk="icon" placeholder="图标" value="' + esc(it.icon || "") + '">' +
        '<button type="button" class="adm-iconbtn danger" data-repeat-del title="删除">🗑</button></div>';
    }

    function catRowHtml(it, opts) {
      it = it || {};
      var have = {};
      (opts || []).forEach(function (c) { have[c.slug] = 1; });
      var missing = it.slug && !have[it.slug];
      return '<div class="adm-thp-cat-row" data-repeat-row>' +
        '<select class="adm-select" data-rk="slug">' +
        '<option value="">— 选择分类 —</option>' +
        (opts || []).map(function (c) {
          return '<option value="' + esc(c.slug) + '"' + (it.slug === c.slug ? " selected" : "") + ">" +
            esc(c.name) + "</option>";
        }).join("") +
        (missing ? '<option value="' + esc(it.slug) + '" selected>' + esc(it.slug) + "（已删除）</option>" : "") +
        "</select>" +
        '<input class="adm-input" data-rk="title" placeholder="标题留空则用分类名" value="' + esc(it.title || "") + '">' +
        '<button type="button" class="adm-iconbtn" data-repeat-up" title="上移">↑</button>' +
        '<button type="button" class="adm-iconbtn" data-repeat-down" title="下移">↓</button>' +
        '<button type="button" class="adm-iconbtn danger" data-repeat-del title="删除">🗑</button></div>';
    }

    function loadCats() {
      if (catsCache) return catsCache;
      catsCache = fetch("/api/categories")
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; });
      return catsCache;
    }

    loadCats().then(function (cats) {
      cats = Array.isArray(cats) ? cats : [];
      catOptions = cats.map(function (c) { return { slug: c.slug, name: c.name }; });
      root.querySelectorAll('[data-repeat="cats"]').forEach(function (holder) {
        var key = holder.getAttribute("data-k");
        var vals = Array.isArray(draft[key]) ? draft[key] : [];
        var state = holder.querySelector(".adm-thp-cats-state");
        if (state) state.remove();
        holder.querySelectorAll("[data-repeat-row]").forEach(function (r) { r.remove(); });
        var addBtn = holder.querySelector("[data-repeat-add]");
        vals.forEach(function (it) {
          addBtn.insertAdjacentHTML("beforebegin", catRowHtml(it, catOptions));
        });
      });
    });

    function renderNav(groupEl, sections) {
      if (!sections.length) {
        groupEl.hidden = true;
        return;
      }
      var list = groupEl.querySelector(".adm-thp-navlist");
      list.innerHTML = sections.map(function (s) {
        return '<button type="button" class="adm-thp-navbtn' +
          (s.key === activeKey ? " is-active" : "") + '" data-sec="' +
          esc(s.key) + '">' + esc(s.label) + "</button>";
      }).join("");
    }

    function renderSection() {
      var sec = null;
      for (var i = 0; i < allSections.length; i++) {
        if (allSections[i].key === activeKey) { sec = allSections[i]; break; }
      }
      var body = root.querySelector("[data-thp-body]");
      if (!sec) {
        body.innerHTML = '<p class="adm-hint">该主题没有声明可配置项。</p>';
        return;
      }
      var html = "<h2 class='adm-thp-sec-title'>" + esc(sec.label) + "</h2>";
      if (sec.description) html += '<p class="adm-thp-sec-desc">' + esc(sec.description) + "</p>";
      html += '<div class="adm-thp-form">' +
        sec.fields.filter(function (f) { return f.type !== "hidden"; }).map(fieldHtml).join("") +
        "</div>";
      body.innerHTML = html;
    }

    function setActiveNav() {
      root.querySelectorAll("[data-sec]").forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-sec") === activeKey);
      });
    }

    function applyShowIf() {
      root.querySelectorAll("[data-fld]").forEach(function (box) {
        var key = box.getAttribute("data-fld");
        var f = fields.filter(function (x) { return x.key === key; })[0];
        if (!f || !f.showIf) return;
        box.hidden = !fieldVisible(f);
      });
    }

    function kebab(k) {
      return "--" + k.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
    }
    function updatePreview() {
      var base = panel.baselineConfig || {};
      var real = {};
      appearance.forEach(function (s) {
        (s.fields || []).forEach(function (f) {
          var v = draft[f.key];
          var s0 = typeof v === "string" ? v.trim() : "";
          if (!s0) return;
          if (typeof base[f.key] === "string" && String(base[f.key]).trim() === s0) return;
          real[f.key] = s0;
        });
      });
      var preset = (panel.palettes || {})[draft.palette] || {};
      var merged = Object.assign({}, base, preset, real);
      var decls = [];
      Object.keys(merged).forEach(function (k) {
        if (k === "customCss") return;
        var v = merged[k];
        if (v == null || String(v).trim() === "") return;
        decls.push(kebab(k) + ":" + String(v));
      });
      decls.push("--bg:" + (merged.background || "#09090b"));
      decls.push("color-scheme:" + (merged.colorScheme || "dark"));
      root.querySelector("[data-thp-preview]").style.cssText = decls.join(";");
    }

    function setMsg(kind, text) {
      var el = root.querySelector("[data-thp-msg]");
      el.textContent = text || "";
      el.className = "adm-thp-msg" + (kind ? " is-" + kind : "");
      if (text) setTimeout(function () { if (el.textContent === text) el.textContent = ""; }, 4000);
    }

    root.addEventListener("click", function (e) {
      var secBtn = e.target.closest && e.target.closest("[data-sec]");
      if (secBtn) {
        activeKey = secBtn.getAttribute("data-sec");
        renderSection();
        setActiveNav();
        return;
      }
      var sw = e.target.closest && e.target.closest('[data-t="switch"]');
      if (sw && root.contains(sw)) {
        var skey = sw.getAttribute("data-k");
        draft[skey] = !draft[skey];
        sw.querySelector(".track").classList.toggle("is-on", !!draft[skey]);
        applyShowIf();
        return;
      }
      var addBtn = e.target.closest && e.target.closest("[data-repeat-add]");
      if (addBtn) {
        var holder = addBtn.closest("[data-repeat]");
        var kind = holder.getAttribute("data-repeat");
        if (kind === "links") {
          addBtn.insertAdjacentHTML("beforebegin", linkRowHtml({}));
        } else {
          addBtn.insertAdjacentHTML("beforebegin", catRowHtml({}, catOptions));
        }
        return;
      }
      var del = e.target.closest && e.target.closest("[data-repeat-del]");
      if (del) { del.closest("[data-repeat-row]").remove(); return; }
      var up = e.target.closest && e.target.closest("[data-repeat-up]");
      var down = e.target.closest && e.target.closest("[data-repeat-down]");
      if (up || down) {
        var row = (up || down).closest("[data-repeat-row]");
        if (up && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
        if (down && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
      }
    });

    function readRepeat(holder) {
      var rows = holder.querySelectorAll("[data-repeat-row]");
      return [].slice.call(rows).map(function (r) {
        var out = {};
        r.querySelectorAll("[data-rk]").forEach(function (inp) {
          out[inp.getAttribute("data-rk")] = inp.value;
        });
        return out;
      });
    }

    root.addEventListener("input", function (e) {
      var t = e.target;
      if (!t.hasAttribute || !t.hasAttribute("data-k")) return;
      var key = t.getAttribute("data-k");
      var f = fields.filter(function (x) { return x.key === key; })[0];
      if (f && f.type === "number") draft[key] = Number(t.value);
      else if (f && f.type === "range") draft[key] = Number(t.value);
      else draft[key] = t.value;
      if (f && f.type === "font") t.style.fontFamily = t.value || "inherit";
      var cbox = t.closest("[data-fld]");
      if (cbox) {
        if (t.type === "color") {
          var txt = cbox.querySelector('input[type="text"][data-k]');
          if (txt) txt.value = t.value;
        } else {
          var pick = cbox.querySelector("input[type=color]");
          if (pick && /^#[0-9a-f]{6}$/i.test(t.value)) pick.value = t.value;
        }
      }
      var rv = f && f.type === "range" && root.querySelector('[data-range-val="' + key + '"]');
      if (rv) rv.textContent = t.value + (f.unit || "");
      applyShowIf();
      updatePreview();
    });
    root.addEventListener("change", function (e) {
      var t = e.target;
      if (t.hasAttribute && t.hasAttribute("data-img-key")) {
        var f0 = t.files && t.files[0];
        t.value = "";
        if (!f0) return;
        var btn = t.parentElement;
        btn.classList.add("is-busy");
        var fd = new FormData();
        fd.append("file", f0);
        fetch("/api/media", { method: "POST", body: fd })
          .then(async function (res) {
            var data = {};
            try { data = await res.json(); } catch (err) {}
            if (!res.ok) throw new Error(data.error || "上传失败 (" + res.status + ")");
            var url = data.url || data.path || data.src || "";
            var ik = t.getAttribute("data-img-key");
            draft[ik] = url;
            var box = t.closest("[data-fld]");
            box.querySelector("[data-k]").value = url;
            box.querySelector(".adm-wg-img-prev").src = url;
          })
          .catch(function (err) { toast(err.message, "err"); })
          .finally(function () { btn.classList.remove("is-busy"); });
        return;
      }
      if (!t.hasAttribute || !t.hasAttribute("data-k")) return;
      var key = t.getAttribute("data-k");
      var fld = fields.filter(function (x) { return x.key === key; })[0];
      if (fld && fld.type === "number") draft[key] = Number(t.value);
      else if (fld && fld.type === "range") draft[key] = Number(t.value);
      else draft[key] = t.value;
      applyShowIf();
      updatePreview();
    });

    function collectDraft() {
      root.querySelectorAll("[data-repeat]").forEach(function (holder) {
        draft[holder.getAttribute("data-k")] = readRepeat(holder);
      });
      return draft;
    }

    root.querySelector("[data-thp-save]").addEventListener("click", async function () {
      var btn = root.querySelector("[data-thp-save]");
      var label = root.querySelector("[data-thp-save-label]");
      btn.disabled = true;
      label.textContent = "保存中…";
      try {
        await api("PUT", "/api/themes/" + encodeURIComponent(panel.theme.slug) + "/settings", collectDraft());
        setMsg("ok", "已保存，刷新前台即可看到效果");
        toast("已保存", "ok");
      } catch (err) {
        setMsg("err", err.message);
      } finally {
        btn.disabled = false;
        label.textContent = "保存";
      }
    });

    root.querySelector("[data-thp-reset]").addEventListener("click", async function () {
      if (!confirm("恢复为主题自带的默认配置？当前的自定义修改会丢失。")) return;
      var btn = root.querySelector("[data-thp-reset]");
      btn.disabled = true;
      try {
        var fresh = await api("DELETE", "/api/themes/" + encodeURIComponent(panel.theme.slug) + "/settings");
        panel = fresh;
        draft = Object.assign({}, panel.config || {}, panel.settings || {});
        renderNav(root.querySelector('[data-thp-nav-group="appearance"]'), panel.appearanceSchema || []);
        renderNav(root.querySelector('[data-thp-nav-group="settings"]'), panel.settingsSchema || []);
        renderSection();
        updatePreview();
        setMsg("ok", "已恢复主题默认值");
      } catch (err) {
        setMsg("err", err.message);
      } finally {
        btn.disabled = false;
      }
    });

    renderNav(root.querySelector('[data-thp-nav-group="appearance"]'), appearance);
    renderNav(root.querySelector('[data-thp-nav-group="settings"]'), own);
    var areaUl = root.querySelector("[data-thp-areas]");
    areaUl.innerHTML = (panel.widgetAreas || []).map(function (a) {
      return "<li><span>" + esc(a.label) + "</span><code>" + esc(a.key) + "</code>" +
        (a.description ? '<em>' + esc(a.description) + "</em>" : "") + "</li>";
    }).join("");
    renderSection();
    updatePreview();
  }

  function initWidgets() {
    markActiveNav();
    hydrateControls();
    initEditor();
    initMedia();
    initImageFields();
    initMenus();
    initWidgetManager();
    initMenuSettings();
    initThemeManager();
    initThemePanel();
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
