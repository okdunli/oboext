/**
 * Admin live-refresh: the one definition of the /api/admin-stream polling
 * loop and the 5s leading+trailing refresh throttle. Shared by every admin
 * page that shows live badges (dashboard, posts, comments) - three byte
 * identical inline copies used to drift independently.
 *
 * startAdminLive(onEvent): starts the poll loop, calls onEvent() on every
 * fresh event (already throttled by adminEvtNudge), returns a stop() that
 * cancels timers and aborts the in-flight request.
 */
(function () {
  "use strict";

  var POLL_MS = 4000;

  // 节流：5s 窗口 leading+trailing，一次窗口至多一次 onEvent；时间戳挂
  // window——本脚本只加载一次，但各页脚本会随重渲重跑，状态必须跨重渲存活。
  function adminEvtNudge(onEvent) {
    var now = Date.now();
    var last = window.__rosezmAdminEvt || 0;
    if (now - last >= 5000) {
      window.__rosezmAdminEvt = now;
      if (window.__rosezmAdminEvtT) {
        clearTimeout(window.__rosezmAdminEvtT);
        window.__rosezmAdminEvtT = 0;
      }
      onEvent();
    } else if (!window.__rosezmAdminEvtT) {
      // 尾沿：窗口内被抑制的事件在窗口结束时补一次——纯前沿会把本集群最后
      // 一条评论丢到下一个事件（B 自己的动作开窗 → A 随后的评论不可见）。
      window.__rosezmAdminEvtT = setTimeout(function () {
        window.__rosezmAdminEvtT = 0;
        window.__rosezmAdminEvt = Date.now();
        onEvent();
      }, 5000 - (now - last));
    }
  }

  function startAdminLive(onEvent) {
    // 轮询循环。端点**立即返回**（绝不在服务端 hold）：框架的 api 分发把整个
    // 请求单元放进了全局串行队列（edge 处理器包住 api 分发），生产形态走的
    // 正是这条路——任何 hold 都会把公开页面排在后台标签页后面，实测 3s hold
    // 让并发页面请求也等了 3.1s。所以节奏在客户端：
    //  - 有新事件（events>0）→ 立刻重问一次（连点两下即收敛，不必等间隔）；
    //  - 无新事件 → POLL_MS 后再问；
    //  - 请求失败 → 退避 5s→10s→30s，绝不允许热循环打爆服务端。
    var stopped = false;
    var since = 0;
    var backoff = 5000;
    var timer = 0;
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    function step(delay) {
      if (stopped) return;
      if (delay) {
        timer = setTimeout(run, delay);
        return;
      }
      run();
    }
    function run() {
      if (stopped) return;
      var url = "/api/admin-stream?since=" + since;
      fetch(url, ctl ? { signal: ctl.signal, headers: { accept: "application/json" } } : undefined)
        .then(function (r) {
          if (!r.ok) throw new Error("stream " + r.status);
          backoff = 5000;
          return r.json();
        })
        .then(function (d) {
          if (stopped) return;
          if (d && typeof d.ver === "number") since = d.ver;
          if (d && d.events > 0) {
            adminEvtNudge(onEvent);
            step(); // 还有新事件就立刻再问，连点即收敛
          } else {
            step(POLL_MS); // 空闲：按间隔轮询
          }
        })
        .catch(function () {
          if (stopped) return;
          step(backoff);
          backoff = Math.min(backoff * 2, 30000);
        });
    }
    step(0);
    return function stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (ctl) ctl.abort();
    };
  }

  window.adminEvtNudge = adminEvtNudge;
  window.startAdminLive = startAdminLive;
})();
