import { toast } from "@folio/ui";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";
import { updateAction } from "./update-action";

// 运行中定时探更新的节奏(ADR 0051):30 分钟一次 + 页面重新可见时各一次。浏览器默认不主动重查
// sw.js,不探的话长会话里永远发现不了新版(要等下次冷启动 splash 静默换)。
const UPDATE_POLL_MS = 30 * 60 * 1000;
// 更新 toast 固定 id:多来源只留一条,不叠。
export const UPDATE_TOAST_ID = "sw-update";

// Service Worker 注册 + 版本更新流的客户端侧(ADR 0051,取代 0027 的「全程静默」)。
//
// 生产才注册(dev 不注册,免本地被缓存坑);在 app 挂载后调用(非模块加载期)。失败静默降级:
// SW 只是增强(离线外壳 + Android 可安装),不支持它的旧浏览器仍作已装 App 用,不影响主功能。
//
// 三条更新路径共用这套机制,只是触发语境不同:
//   · 冷启动闪屏发现 waiting(有旧 controller)→ silent-activate:自动换 + 闪屏「更新中」→ reload。
//   · 运行中(updatefound)发现 waiting → prompt:亮起「有新版可换」信号(设置页据此显示、后续切片弹 toast)。
//   · 设置页 / toast 点「更新」→ applyUpdate();点「检查更新」→ checkForUpdate()。
// 首次安装(无旧 controller)一律 none —— 让新版随 activate 自然接手,不打扰。

// ── splash「更新中」信号:applyUpdate 点亮,SplashScreen 订阅后显示「更新中」 ──
let updating = false;
const updatingListeners = new Set<() => void>();

// ── 「有新版可换」信号:运行中检测到 waiting 时点亮,设置页(和后续 toast)订阅 ──
// 存 worker 本身(不只是布尔):后续切片的 toast 要按 worker 身份去重(同版本只弹一次)。
let availableWorker: ServiceWorker | null = null;
const availableListeners = new Set<() => void>();

let registration: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;
let reloading = false;
// 已为哪个 waiting worker 弹过 toast:同一个版本只弹一次,换了更新的版本(新 worker)才再弹。
let lastPromptedWorker: ServiceWorker | null = null;

function beginUpdating(): void {
  if (updating) return;
  updating = true;
  for (const notify of updatingListeners) notify();
}

function setAvailable(worker: ServiceWorker | null): void {
  if (availableWorker === worker) return;
  availableWorker = worker;
  for (const notify of availableListeners) notify();
}

/**
 * 点亮 splash「更新中」并让 waiting 新版接管:postMessage SKIP_WAITING → SW skipWaiting →
 * controllerchange → 本页 reload 到新版。设置页 / toast 的「更新」按钮都走这里。
 */
function applyUpdate(): void {
  if (!waitingWorker) return;
  beginUpdating();
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

/**
 * 手动检查更新(设置页那颗刷新)。等新 worker 装完再回答,好让调用点据此 toast「有新版本」还是
 * 「已是最新」。真有新版会同时走 updatefound → 亮「有新版」信号(设置页不依赖它,直接看返回值)。
 * @returns 检查后是否有 waiting 的新版本可换。
 */
export async function checkForUpdate(): Promise<boolean> {
  if (!registration) return false;
  try {
    await registration.update();
    // update() resolve 时新 worker 可能还在 installing → 等它落定,waiting 才准。
    const installing = registration.installing;
    if (installing) {
      await new Promise<void>((resolve) => {
        const onState = () => {
          if (installing.state === "installed" || installing.state === "redundant") {
            installing.removeEventListener("statechange", onState);
            resolve();
          }
        };
        installing.addEventListener("statechange", onState);
      });
    }
    return registration.waiting != null;
  } catch {
    // 静默:网络问题不该冒泡到 UI。
    return false;
  }
}

// 发现 waiting 新版时按语境决定动作。
function consider(reg: ServiceWorkerRegistration, context: "splash" | "running"): void {
  const waiting = reg.waiting;
  if (!waiting) return;
  const action = updateAction({
    hasWaiting: true,
    hasController: navigator.serviceWorker.controller != null,
    context,
  });
  if (action === "silent-activate") {
    waitingWorker = waiting;
    applyUpdate(); // 冷启动:自动静默换版
  } else if (action === "prompt") {
    waitingWorker = waiting;
    setAvailable(waiting); // 运行中:亮起「有新版可换」(UI 由设置页 / 后续 toast 承接)
  }
}

/** 注册 SW 并接线更新流。返回清理函数。生产才真跑。 */
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

  // 运行中定时探更新:30 分钟一次 + 页面重新可见时各一次。checkForUpdate 在 registration 落地前
  // 是 no-op,所以同步起这两个也安全。
  const poll = setInterval(() => void checkForUpdate(), UPDATE_POLL_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  };
  document.addEventListener("visibilitychange", onVisible);

  // updateViaCache:none —— 更新检查不吃 HTTP 缓存,发新版即拿到新 sw.js。
  navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .then((reg) => {
      registration = reg;
      // 冷启动:上次没换、这次发现 waiting 已就位 → 静默换版 + 闪屏「更新中」→ reload。
      consider(reg, "splash");
      // 运行中:新版装好 → 亮起「有新版」信号。
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed") consider(reg, "running");
        });
      });
    })
    .catch(() => {
      // 静默:注册失败不该冒泡到 UI。
    });

  return () => {
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    clearInterval(poll);
    document.removeEventListener("visibilitychange", onVisible);
  };
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

/**
 * 弹「有新版本 · 更新」toast —— 运行中自动提示与设置页手动检查**共用这一处**(去重契约「多来源只留
 * 一条」靠固定 id `UPDATE_TOAST_ID` + 单一构造,不靠两处对齐字符串)。顺手记下已为当前 worker 提示过
 * (`lastPromptedWorker`),这样手动弹过之后自动路径不会对同一版本再补一发。文案由调用点从 use-intl 取
 * 好传进来(本模块非 React,不便调 hook)。
 */
export function showUpdateToast(labels: { available: string; update: string }): void {
  lastPromptedWorker = availableWorker;
  toast.message(labels.available, {
    id: UPDATE_TOAST_ID,
    action: { label: labels.update, onClick: () => applyUpdate() },
  });
}

/**
 * 运行中弹「有新版本」toast(会自动消失、可忽略)。**同一个 waiting 版本只弹一次**(按 worker 身份
 * 去重),后续定时探到同版本不重复弹;换了更新的版本(新 worker)才再弹。忽略/关掉 toast 后设置页那行
 * 仍能回去更新。挂一次(在 RootDocument 内)。
 */
export function useUpdateToast(): void {
  const t = useTranslations("Update");
  useEffect(() => {
    const maybePrompt = () => {
      if (!availableWorker || availableWorker === lastPromptedWorker) return;
      showUpdateToast({ available: t("available"), update: t("update") });
    };
    availableListeners.add(maybePrompt);
    maybePrompt(); // 订阅前若已检测到新版,补弹一次
    return () => {
      availableListeners.delete(maybePrompt);
    };
  }, [t]);
}
