// SW 更新动作的纯判定(测试缝,ADR 0051 / 对齐 sw-route)。三条更新路径的分叉都归到这里,
// 副作用(skipWaiting / 弹 toast / reload)留在 service-worker.ts。

type UpdateAction = "silent-activate" | "prompt" | "none";

export interface UpdateContext {
  /** 有装好、正停在 waiting 的新版 worker(`reg.waiting`)。 */
  hasWaiting: boolean;
  /** 有旧版在接管本页(`navigator.serviceWorker.controller`)—— 即「有得可换」。 */
  hasController: boolean;
  /** 语境:冷启动闪屏里发现的,还是运行中发现的。 */
  context: "splash" | "running";
}

/**
 * 该拿这个 waiting 新版怎么办:
 *   没有 waiting → none(没新版)
 *   有 waiting 但没有旧 controller → none(**首次安装**,没有「旧版」可换,让它随 activate 自然接手,不打扰)
 *   闪屏语境 → silent-activate(自动静默换版 + 显「更新中」)
 *   运行中语境 → prompt(弹「有新版本 · 更新」,交给用户)
 */
export function updateAction(c: UpdateContext): UpdateAction {
  if (!c.hasWaiting) return "none";
  if (!c.hasController) return "none";
  return c.context === "splash" ? "silent-activate" : "prompt";
}
