// R243 实时事件核心发射端：管理后台「新评论/待审数」实时刷新（Step 1，服务端侧）。
// admin.ts 的评论写路径调用 emitAdminEvent("comment")，写进框架 $store 的进程级
// 共享 box；框架 server bundle 已把 store 写传输到 SSE（/__rosezm_store）与跨
// worker 中继，这里只负责写。ver 单调递增、无去重——由客户端节流兜底。
//
// payload 纪律（_REALTIME_DESIGN_R243.md §4.2）：SSE 端点无鉴权 → 只允许
// {kind, ver}；评论内容/作者/邮箱/计数一律不进 payload，客户端节流后 refresh()
// 从自己有权限的接口重取。
//
// R245：本模块的 $store 调用**不会**点亮客户端通道。compiler 的 usesStore 判定
// （src/compiler/index.ts:1423/:1499）只扫 .rose 路由脚本原文，TS 模块不在其中；
// 而管理页已按 R245 移除了 $store 字面（prod 下 /__rosezm_store 无挂载，留着就是
// 无限重连风暴）。所以这里的 $store 只是进程内的 ver 计数盒 + dev/preview 的框架
// 通道来源，两种用途都不依赖客户端订阅。
import { $store } from "rosezm/runtime";

export type AdminEventKind = "comment";

export const ADMIN_EVENTS_STORE = "oboext-admin-events";

export type AdminEvent = { kind: AdminEventKind | null; ver: number };

// 进程级共享 box：$store 注册表挂 globalThis（rosezm/runtime 的 index），
// dev 热重载后新模块实例复用同一 box，ver 不回退。
const adminEvents = $store<AdminEvent>(ADMIN_EVENTS_STORE, { kind: null, ver: 0 });

// 进程内订阅者（应用侧 api 路由的实时连接）。同样挂 globalThis：dev 热重载会重新
// import 本模块与路由模块，已建立的连接必须仍能被新模块实例通知到。
const localSubs: Set<(e: AdminEvent) => void> =
  (globalThis as any).__oboeAdminEventSubs || ((globalThis as any).__oboeAdminEventSubs = new Set());

/**
 * 订阅进程内管理事件；返回退订函数（连接关闭时必须调用，否则 Set 只增不减）。
 *
 * **当前无生产调用方**，这是有意的：R245 的 `/api/admin-stream` 是立即返回型
 * 轮询（见该文件顶部说明：框架把请求放进全局串行队列，任何 hold 都会阻塞
 * 整站），轮询只比较 `currentAdminVersion()` 的 since 游标，不需要订阅。保留
 * 它的原因：一旦上游给 prod-server 补上流式直通、并把 api 分发移出 edge 队列，
 * SSE/长轮询可直接接这张表，无需重写本模块。行为由 scripts/admin-sse.test.mts
 * 锁定（收到 → 退订后收不到 → 抛错订阅者不破坏发射端）。
 */
export function subscribeAdminEvents(cb: (e: AdminEvent) => void): () => void {
  localSubs.add(cb);
  return () => {
    localSubs.delete(cb);
  };
}

/**
 * 当前事件版本号（单调递增）。轮询端点拿它和客户端的 `since` 比较：读的是
 * $store box 的当前值，所以跨模块实例、跨热重载都一致。
 */
export function currentAdminVersion(): number {
  try {
    return adminEvents.get().ver;
  } catch {
    return 0;
  }
}

// 失败静默：广播只是通知，DB/审计已完成——绝不能把 store/SSE 故障抛回写路径。
export function emitAdminEvent(kind: AdminEventKind): void {
  let next: AdminEvent = { kind, ver: 0 };
  try {
    adminEvents.update((v) => (next = { kind, ver: v.ver + 1 }));
  } catch {
    // 丢一次通知可容忍（客户端节流 refresh 兜底），写路径必须继续。
  }
  // 两条通道互不牵连：$store 传输失败（上面吞掉）时本地订阅者照常收到；单个
  // 订阅者抛错也不影响其它订阅者，更不冒泡到评论写路径。
  for (const cb of [...localSubs]) {
    try {
      cb(next);
    } catch {
      /* 一个连接写失败：其余连接与写路径继续 */
    }
  }
}
