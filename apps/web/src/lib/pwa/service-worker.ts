import { useSyncExternalStore } from "react";
import { updateAction } from "./update-action";

// Service Worker 注册 + 版本更新流的客户端侧(ADR 0051,取代 0027 的「全程静默」)。
//
// 生产才注册(dev 不注册,免本地被缓存坑);在 app 挂载后调用(非模块加载期)。失败静默降级:
// SW 只是增强(离线外壳 + Android 可安装),不支持它的旧浏览器仍作已装 App 用,不影响主功能。
//
// **本片(FOL-64)只做冷启动的静默换版**:注册时若发现有 waiting 的新版且已有旧 controller
// (updateAction → silent-activate),就自动让它接管、闪屏亮「更新中」、reload 到新版。首次安装
// (无旧 controller)不触发。运行中的探测 + toast 提示是后续切片。

// splash「更新中」信号:applyUpdate 点亮,SplashScreen 订阅后显示「更新中」。
let updating = false;
const updatingListeners = new Set<() => void>();
let waitingWorker: ServiceWorker | null = null;
let reloading = false;

function beginUpdating(): void {
  if (updating) return;
  updating = true;
  for (const notify of updatingListeners) notify();
}

// 点亮 splash「更新中」并让 waiting 新版接管:postMessage SKIP_WAITING → SW skipWaiting →
// controllerchange → 本页 reload 到新版。
function applyUpdate(): void {
  if (!waitingWorker) return;
  beginUpdating();
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

// 发现 waiting 新版时按语境决定动作。本片只处理 silent-activate(闪屏静默换版);运行中的 prompt
// 归后续切片,那时会扩这里 + 加 updatefound / 定时探。
function consider(reg: ServiceWorkerRegistration, context: "splash" | "running"): void {
  const waiting = reg.waiting;
  if (!waiting) return;
  const action = updateAction({
    hasWaiting: true,
    hasController: navigator.serviceWorker.controller != null,
    context,
  });
  if (action !== "silent-activate") return;
  waitingWorker = waiting;
  applyUpdate();
}

/** 注册 SW 并接线更新流。返回清理函数(移除 controllerchange 监听)。生产才真跑。 */
export function registerServiceWorker(): () => void {
  if (!import.meta.env.PROD) return () => {};
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};

  // controllerchange:waiting 新版接管的信号 —— 只在**我们主动 SKIP_WAITING**后发生(首次安装不换
  // controller)。reloading 兜住重复触发,只刷一次。
  const onControllerChange = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

  // updateViaCache:none —— 更新检查不吃 HTTP 缓存,发新版即拿到新 sw.js。
  navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .then((reg) => {
      // 冷启动:上次没换、这次发现 waiting 已就位 → 静默换版 + 闪屏「更新中」→ reload。
      consider(reg, "splash");
    })
    .catch(() => {
      // 静默:注册失败不该冒泡到 UI。
    });

  return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
}

/** SplashScreen 订阅:是否正在应用新版本(显示「更新中」)。 */
export function useSplashUpdating(): boolean {
  return useSyncExternalStore(
    (cb) => {
      updatingListeners.add(cb);
      return () => updatingListeners.delete(cb);
    },
    () => updating,
    () => false,
  );
}
