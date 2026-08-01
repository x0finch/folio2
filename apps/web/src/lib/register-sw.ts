// 生产环境注册 Service Worker(ADR 0027)。dev 不注册 —— 免本地被 SW 缓存坑;
// 在 app 挂载后调用(非模块加载期)。失败静默降级:SW 只是增强(离线外壳 + Android 可安装),
// 不支持 module worker 的旧浏览器仍作已装 App 用,不影响主功能。
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // updateViaCache:none —— 更新检查不吃 HTTP 缓存,发新版即拿到新 sw.js。
  navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .catch(() => {
      // 静默:注册失败不该冒泡到 UI。
    });
}
