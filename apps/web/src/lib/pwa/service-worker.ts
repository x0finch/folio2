import { toast } from "@folio/ui";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";
import { isNewerVersion, parseSwBuild, RUNNING_VERSION } from "./version";

// 运行中定时探更新的节奏(ADR 0051):30 分钟一次 + 页面重新可见时各一次。浏览器默认不主动重查,
// 不探的话长会话里发不了新版。
const UPDATE_POLL_MS = 30 * 60 * 1000;
// 更新 toast 固定 id:多来源只留一条,不叠。
export const UPDATE_TOAST_ID = "sw-update";
// 点「更新」后先把 splash「更新中」显示这么久,再切/reload —— 否则 skipWaiting 太快,文案一闪看不到。
const UPDATING_MIN_MS = 600;

// Service Worker 注册 + 版本更新流(ADR 0051,「诚实的·联网总是最新」模型,取代 0027 全程静默)。
//
// **关键事实**:导航是 network-first(见 public/sw.js),联网时每次冷启动 / 硬刷新都会拿到最新 HTML+JS
// —— 所以「当前在跑的版本」冷启动后本来就是最新。真正需要提示的只有一种情形:**一个会话长时间开着,
// 期间上游发了新版**,这时已加载的内容才落后于线上。判断「落后」用版本号直比:线上 sw.js 的 `@sw-build`
// ↔ 本次加载的 `__APP_VERSION__`,不同就是有新版(不再靠 SW 的 waiting 竞态 —— 那条在 network-first 下
// 语义不清:冷启动的 waiting 与已加载内容同版,毫无可更新之物)。
//
// 三个触发点都归到「比版本」:
//   · 运行中定时 / 重新可见 → 探到线上更新 → 亮「有新版」信号 → 常驻 toast「有新版本 · 更新」(同版只弹一次)。
//   · 设置页刷新 → checkForUpdate() 同款比对:有则 toast、无则「已是最新」。
//   · 点「更新」→ applyUpdate():亮 splash「更新中」→ 让 waiting 新版接管(或直接 reload)→ 到新版。
// **冷启动 / 首次安装什么都不弹** —— 内容已是最新,没有可更新的对象。

// ── splash「更新中」信号:applyUpdate 点亮,SplashScreen 订阅后显示「更新中」 ──
let updating = false;
const updatingListeners = new Set<() => void>();

// ── 「有新版可换」信号:存**那个更新的版本号**(不是布尔),便于按版本去重(同版只弹一次) ──
let availableVersion: string | null = null;
const availableListeners = new Set<() => void>();

let registration: ServiceWorkerRegistration | null = null;
// 已为哪个版本弹过 toast:同一版本只弹一次,换了更新的版本才再弹。
let lastPromptedVersion: string | null = null;
let reloading = false;

function beginUpdating(): void {
  if (updating) return;
  updating = true;
  for (const notify of updatingListeners) notify();
}

function setAvailable(version: string | null): void {
  if (availableVersion === version) return;
  availableVersion = version;
  for (const notify of availableListeners) notify();
}

/**
 * 拉一次线上 sw.js,取出它戳进去的构建版本(`@sw-build`);拿不到返回 null。
 * **唯一 query 参数破缓存**:`cache:"no-store"` 只绕浏览器缓存,绕不过 Cloudflare 边缘缓存,而 `/sw.js`
 * 是非哈希静态资源、边缘会缓存它 —— 不破缓存的话发新版后这里仍读到旧版本号,更新永远探不到(点刷新
 * 判「已是最新」,只有整页导航才更新)。边缘按完整 URL 做 cache key,加时间戳 → 必回源拿最新。
 */
async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/sw.js?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return parseSwBuild(await res.text());
  } catch {
    // 静默:网络问题不该冒泡到 UI。
    return null;
  }
}

/**
 * 点亮 splash「更新中」并切到新版:先让文案看得见(UPDATING_MIN_MS),再让 waiting 新版 skipWaiting
 * (→ controllerchange → 本页 reload),没有 waiting 就直接 reload(network-first 一样拿到最新)。
 * 设置页 / toast 的「更新」按钮都走这里。
 */
function applyUpdate(): void {
  if (reloading) return;
  beginUpdating();
  setTimeout(() => {
    const waiting = registration?.waiting;
    if (waiting) {
      waiting.postMessage({ type: "SKIP_WAITING" });
    } else {
      reloading = true;
      window.location.reload();
    }
  }, UPDATING_MIN_MS);
}

/**
 * 探一次线上是否有新版(比版本号)。有则记下(供 toast 去重)、返回 true,并顺手 kick 一次
 * registration.update() 让新版在后台装成 waiting,用户点更新时能直接 skipWaiting。
 * @returns 线上是否有比当前在跑的更新的版本。
 */
export async function checkForUpdate(): Promise<boolean> {
  const deployed = await fetchDeployedVersion();
  const newer = isNewerVersion(deployed, RUNNING_VERSION);
  if (newer) {
    setAvailable(deployed);
    registration?.update().catch(() => {});
  }
  return newer;
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

  // 运行中定时探 + 重新可见时各探一次:探到线上更新就亮「有新版」信号(toast 由 useUpdateToast 承接)。
  // 冷启动时线上版本 == 已加载版本 → isNewerVersion 为 false → 不弹,符合「联网已是最新」。
  const poll = setInterval(() => void checkForUpdate(), UPDATE_POLL_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  };
  document.addEventListener("visibilitychange", onVisible);

  // updateViaCache:none —— 注册/更新检查不吃 HTTP 缓存,发新版即拿到新 sw.js。
  navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .then((reg) => {
      registration = reg;
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
 * 弹「有新版本 · 更新」**常驻** toast(不自动消失,可手动划走)—— 运行中自动提示与设置页手动检查共用这一处
 * (去重契约「多来源只留一条」靠固定 id `UPDATE_TOAST_ID` + 单一构造)。顺手记下已为当前版本提示过
 * (`lastPromptedVersion`),自动路径不会对同一版本再补一发。文案由调用点从 use-intl 取好传进来。
 */
export function showUpdateToast(labels: { available: string; update: string }): void {
  lastPromptedVersion = availableVersion;
  toast.message(labels.available, {
    id: UPDATE_TOAST_ID,
    duration: 0, // 常驻(toast-store 约定:0 = 不自动消失,可手动划走)
    action: { label: labels.update, onClick: () => applyUpdate() },
  });
}

/**
 * 运行中探到新版就弹常驻 toast。**同一个版本只弹一次**(按版本号去重),后续定时探到同版本不重复弹;
 * 换了更新的版本才再弹。划走 toast 后设置页那行仍能回去更新。挂一次(在 RootDocument 内)。
 */
export function useUpdateToast(): void {
  const t = useTranslations("Update");
  useEffect(() => {
    const maybePrompt = () => {
      if (!availableVersion || availableVersion === lastPromptedVersion) return;
      showUpdateToast({ available: t("available"), update: t("update") });
    };
    availableListeners.add(maybePrompt);
    maybePrompt(); // 订阅前若已探到新版,补弹一次
    return () => {
      availableListeners.delete(maybePrompt);
    };
  }, [t]);
}
