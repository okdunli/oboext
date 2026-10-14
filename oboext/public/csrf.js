/**
 * CSRF header injection — one wrapper, installed before any other script runs.
 *
 * The server (oboext/src/server/csrf.ts, enforced in pages/_middleware.rose)
 * requires a state-changing request that carries the session cookie to also
 * echo the cms_csrf cookie into the X-CSRF-Token header. A guest request has
 * no session cookie and is let through untouched, which is why this wrapper
 * does nothing at all when the cookie is absent.
 *
 * Why wrap `fetch` instead of adding a header at each call site: admin.js
 * alone had twelve direct `fetch(...)` calls (media uploads, plugin install,
 * theme upload, backup restore, db-config, category writes), spread over
 * 4300 lines, and the front-end scripts had four more. Patching call sites
 * means the next one added is unprotected by default and nothing fails when
 * it is missed — the request just returns 400 in production. Wrapping the
 * global means a new call site is covered the moment it is written.
 *
 * Only same-origin unsafe methods are touched. A cross-origin request is left
 * alone deliberately: attaching this site's token to a request aimed somewhere
 * else would leak it.
 */
(function () {
  "use strict";
  if (window.__csrfBound) return;
  window.__csrfBound = true;

  var COOKIE = "cms_csrf=";
  var HEADER = "X-CSRF-Token";
  var SAFE = { GET: 1, HEAD: 1, OPTIONS: 1 };

  function token() {
    var all = document.cookie || "";
    var hit = all.split(";");
    for (var i = 0; i < hit.length; i++) {
      var c = hit[i].trim();
      if (c.indexOf(COOKIE) === 0) return decodeURIComponent(c.slice(COOKIE.length));
    }
    return "";
  }

  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  var native = window.fetch;
  if (typeof native !== "function") return;

  window.fetch = function (input, init) {
    try {
      var url = typeof input === "string" ? input : input && input.url;
      var method = String(
        (init && init.method) || (input && input.method) || "GET"
      ).toUpperCase();
      if (url && !SAFE[method] && sameOrigin(url)) {
        var t = token();
        if (t) {
          init = init || {};
          var copy = {};
          for (var k in init) copy[k] = init[k];
          var h = new Headers(init.headers || (input && input.headers) || {});
          h.set(HEADER, t);
          copy.headers = h;
          init = copy;
        }
      }
    } catch (e) {
      /* never let the wrapper break a request */
    }
    return native.call(this, input, init);
  };
})();
