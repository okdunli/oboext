// Post like button. The endpoint (/api/posts/like) and the counts existed with
// no UI in the default theme; the button is rendered server-side with the
// visitor's current state, and this file only flips it. A delegated listener
// survives pjax's #sk-main swap.
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-post-like]") : null;
    if (!btn || btn.disabled) return;
    var id = Number(btn.getAttribute("data-post-like"));
    if (!Number.isInteger(id) || id <= 0) return;
    var liked = btn.getAttribute("aria-pressed") === "true";
    btn.disabled = true;
    fetch("/api/posts/like", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: id, action: liked ? "unlike" : "like" }),
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data) return;
        var nowLiked = data.liked === true;
        btn.setAttribute("aria-pressed", nowLiked ? "true" : "false");
        btn.classList.toggle("is-liked", nowLiked);
        var count = btn.querySelector("[data-like-count]");
        if (count && typeof data.likes === "number") count.textContent = data.likes;
      })
      .catch(function () {})
      .then(function () {
        btn.disabled = false;
      });
  });
})();
