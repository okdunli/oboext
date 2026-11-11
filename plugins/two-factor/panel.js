/**
 * two-factor admin panel behaviour (external script: the admin document's
 * strict CSP allows 'self' scripts only, so the plugin ships its JS as a file
 * under plugins/two-factor/ and mounts it at /plugin-assets/two-factor/panel.js).
 *
 * Port of the original admin.tsx state machine: load status → idle (begin) →
 * enroll (secret + otpauth + confirm code) → enabled (regen / disable), with
 * the one-time plaintext recovery-code card after confirm/regen. Everything
 * rides the single /api/account/twofa endpoint; a disabled plugin answers 404.
 * Zero dependencies, fully delegated.
 */
(function () {
  "use strict";
  var root = document.querySelector("[data-tf-panel]");
  if (!root || root.__tfBound) return;
  root.__tfBound = true;
  // R531: the server renders the panel with a dictionary on the root element.
  var I = {};
  try {
    I = JSON.parse(root.getAttribute("data-i18n") || "{}") || {};
  } catch (e) {
    I = {};
  }
  function tpl(str, vars) {
    return String(str || "").replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] != null ? String(vars[k]) : m;
    });
  }

  var shownCodes = [];

  function el(attr) {
    return root.querySelector("[" + attr + "]");
  }
  function step(name) {
    root.querySelectorAll("[data-tf-step]").forEach(function (n) {
      n.hidden = n.getAttribute("data-tf-step") !== name;
    });
  }
  function say(text, ok) {
    var e = el("data-tf-error");
    if (!e) return;
    e.textContent = text || "";
    e.hidden = !text;
    e.style.color = ok ? "#4ade80" : "#f87171";
  }

  function call(body) {
    return fetch("/api/account/twofa", {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) throw new Error(d.error || I.op_failed);
        return d;
      });
    });
  }

  function refresh() {
    return call()
      .then(function (s) {
        var state = el("data-tf-state");
        if (state) state.textContent = s.enabled ? I.st_on : s.pending ? I.st_pending : I.st_off;
        var pending = el("data-tf-pending");
        if (pending) pending.hidden = !s.pending;
        var remaining = el("data-tf-remaining");
        if (remaining) remaining.textContent = String(s.recoveryRemaining || 0);
        step(s.enabled ? "on" : "idle");
      })
      .catch(function (err) {
        var state = el("data-tf-state");
        if (state) state.textContent = I.st_unavailable;
        say(err.message, false);
      });
  }

  function showCodes(codes) {
    shownCodes = codes || [];
    var card = el("data-tf-codes");
    var grid = el("data-tf-codes-grid");
    var n = el("data-tf-codes-n");
    if (!card || !grid) return;
    if (n) n.textContent = String(shownCodes.length);
    grid.innerHTML = "";
    shownCodes.forEach(function (c) {
      var code = document.createElement("code");
      code.textContent = c;
      code.style.cssText =
        "display:block;text-align:center;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;letter-spacing:.12em;background:var(--adm-panel-2);border:1px solid var(--adm-border);border-radius:8px;padding:6px 4px;";
      grid.appendChild(code);
    });
    card.hidden = false;
  }

  function begin() {
    say("");
    call({ action: "begin" })
      .then(function (d) {
        var secret = el("data-tf-secret");
        var link = el("data-tf-otpauth");
        if (secret) secret.textContent = d.secret || "";
        if (link) link.href = d.otpauth || "#";
        var input = el("data-tf-confirm");
        if (input) input.value = "";
        var codes = el("data-tf-codes");
        if (codes) codes.hidden = true;
        step("enroll");
        var first = el("data-tf-confirm");
        if (first) first.focus();
      })
      .catch(function (err) { say(err.message, false); });
  }

  function confirm() {
    var input = el("data-tf-confirm");
    var code = (input ? input.value : "").replace(/\D/g, "");
    if (code.length !== 6) return say(I.need_code, false);
    say("");
    call({ action: "confirm", code: code })
      .then(function (d) {
        showCodes(d.recoveryCodes || []);
        return refresh();
      })
      .catch(function (err) { say(err.message, false); });
  }

  function regen() {
    var input = el("data-tf-regen-code");
    var code = (input ? input.value : "").replace(/\D/g, "");
    if (code.length !== 6) return say(I.need_code, false);
    say("");
    call({ action: "regen", code: code })
      .then(function (d) {
        showCodes(d.recoveryCodes || []);
        var box = el("data-tf-regen");
        if (box) box.hidden = true;
        return refresh();
      })
      .catch(function (err) { say(err.message, false); });
  }

  function disable() {
    var pw = el("data-tf-disable-pw");
    var password = pw ? pw.value : "";
    if (!password) return say(I.need_pw, false);
    say("");
    call({ action: "disable", password: password })
      .then(function () {
        if (pw) pw.value = "";
        var box = el("data-tf-disable");
        if (box) box.hidden = true;
        var codes = el("data-tf-codes");
        if (codes) codes.hidden = true;
        return refresh();
      })
      .catch(function (err) { say(err.message, false); });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { say(I.copied, true); },
        function () { say(I.copy_fail, false); },
      );
    } else {
      say(I.copy_unsupported, false);
    }
  }

  root.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-tf-act]");
    if (!btn || !root.contains(btn)) return;
    var act = btn.getAttribute("data-tf-act");
    if (act === "begin") return begin();
    if (act === "confirm") return confirm();
    if (act === "cancel-enroll") {
      say("");
      return refresh();
    }
    if (act === "copy-secret") {
      var secret = el("data-tf-secret");
      return copyText(secret ? secret.textContent : "");
    }
    if (act === "open-regen") {
      var r = el("data-tf-regen");
      if (r) r.hidden = false;
      var d = el("data-tf-disable");
      if (d) d.hidden = true;
      return;
    }
    if (act === "cancel-regen") {
      var r2 = el("data-tf-regen");
      if (r2) r2.hidden = true;
      return;
    }
    if (act === "regen") return regen();
    if (act === "open-disable") {
      var d2 = el("data-tf-disable");
      if (d2) d2.hidden = false;
      var r3 = el("data-tf-regen");
      if (r3) r3.hidden = true;
      return;
    }
    if (act === "cancel-disable") {
      var d3 = el("data-tf-disable");
      if (d3) d3.hidden = true;
      return;
    }
    if (act === "disable") return disable();
    if (act === "copy-codes") return copyText(shownCodes.join("\n"));
    if (act === "download-codes") {
      var blob = new Blob(
        [
          tpl(I.file_header, { time: new Date().toLocaleString() }) +
            "\n\n" +
            shownCodes.join("\n") +
            "\n",
        ],
        { type: "text/plain;charset=utf-8" },
      );
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "oboe-twofa-recovery-codes.txt";
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
  });

  refresh();
})();
