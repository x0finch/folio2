// 手搓运行时缓存 Service Worker(ADR 0027:可安装的移动外壳,**不做离线优先**)。
// 策略:
//   · 导航(文档)→ network-first,失败回退中立的 offline.html(不缓存 SSR 响应 —— 那里带用户数据,
//     离线显示旧余额比诚实报离线更危险)。
//   · hashed 静态(script/style/font,Vite 产物不可变)→ cache-first(秒开、可离线启动外壳)。
//   · 其余(/api、server fn、图片、跨源、非 GET)→ network-only、永不进缓存。
// 更新(ADR 0051,取代 0027):新版装好后**停在 waiting**,不再自动 skipWaiting —— 换版时机交给页面:
//   闪屏阶段自动静默换、运行中弹提示。页面同意时 postMessage `{type:"SKIP_WAITING"}`,这里才接管,
//   随后 controllerchange 触发页面 reload(客户端逻辑见 src/lib/pwa/service-worker.ts)。
// 纯路由决策 swRoute 导出供单测;vitest(node)里 self 无 skipWaiting → 只导出、不挂事件。

// **构建版本戳**:占位 `__SW_BUILD__` 由 vite 插件(见 vite.config 的 stampSwVersion)在打包时换成
// git describe 版本号。作用是让**每次发版 sw.js 的内容都不同** —— 浏览器逐字节比对 sw.js 才认得出
// 「有新版」,而 app 改代码只换 /assets 的 hash、不动 sw.js;没有这行,更新检测(waiting worker)对
// 普通发版永远不触发。纯注释、不影响行为。dev 下保持占位原文(不构建、不注册 SW)。
// @sw-build __SW_BUILD__

// v2:v1 里存过没哈希的 URL(见 swRoute 里那条注释),换桶名让 activate 顺手清掉。
const CACHE = "folio-shell-v2";
const OFFLINE_URL = "/offline.html";

/**
 * 「改一个字节就换 URL」的产物前缀。Vite 把 js/css/字体都输出到 /assets/,文件名带内容哈希,
 * 所以只有它们配得上 cache-first —— 缓存一条永不过期的记录,而它本来也永远不会变。
 */
const IMMUTABLE_PREFIX = "/assets/";

/**
 * 按请求特征选缓存策略(纯函数,便于单测)。
 * @param {{ method: string, mode: string, destination: string, sameOrigin: boolean, pathname: string }} req
 * @returns {"navigation" | "cache-first" | "network-only"}
 */
export function swRoute(req) {
  if (req.method !== "GET") return "network-only"; // 变更类(server fn / mutation),不缓存
  if (req.mode === "navigate") return "navigation"; // 文档:network-first + 外壳兜底
  if (!req.sameOrigin) return "network-only"; // 跨源(如 logo 代理目标)
  if (req.pathname.startsWith("/api/")) return "network-only"; // 数据 / 鉴权,永不缓存
  // **必须同时满足「是静态资源」和「URL 带哈希」**。早先只看 destination,注释写着「hashed 不可变
  // 资源」但代码没验证过这一点 —— 于是任何同源的 script/style/font URL 都被永久钉死:命中即返回、
  // 永不回网络、也没有版本号能淘汰它。真踩过:SW 只在 PROD 注册,可一旦某个域名上跑过一次
  // preview/prod 构建,SW 就长驻;之后在同一域名跑 dev(`dev:tunnel` 的日常),它照样拦
  // `/src/styles.css` 这种不带哈希、内容天天变的 URL,把上一轮的 CSS 一直发下去。表现是
  // 「改了样式手机上不生效,私密标签页却正常」,能查半天。
  const staticDest =
    req.destination === "script" || req.destination === "style" || req.destination === "font";
  if (staticDest && req.pathname.startsWith(IMMUTABLE_PREFIX)) {
    return "cache-first";
  }
  return "network-only"; // 其余默认不缓存(图片 / manifest 等保持新鲜)
}

// SW 全局特征探测:window / node 都没有 skipWaiting → 只有真在 Service Worker 里才挂事件
//(node 单测 self 未定义,短路;只导出 swRoute)。
if (typeof self !== "undefined" && typeof self.skipWaiting === "function") {
  self.addEventListener("install", (event) => {
    // **不再 skipWaiting**:新版装好后停在 waiting,换版时机交给页面(ADR 0051)。首次安装(无旧
    // controller)时页面不会催换,新版随 activate 自然接手 —— 见 service-worker.ts 对 controller 的判断。
    event.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE_URL)));
  });

  // 页面同意换版:收到 SKIP_WAITING 才让 waiting 的新版接管(接管后触发 clients 的 controllerchange)。
  self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        // 清掉旧版本缓存桶(改 CACHE 版本号即淘汰)。
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
        await self.clients.claim();
      })(),
    );
  });

  self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);
    const strategy = swRoute({
      method: req.method,
      mode: req.mode,
      destination: req.destination,
      sameOrigin: url.origin === self.location.origin,
      pathname: url.pathname,
    });

    if (strategy === "network-only") return; // 不拦截,走浏览器默认网络路径

    if (strategy === "navigation") {
      event.respondWith(
        fetch(req).catch(async () => {
          // 离线:回退中立 offline.html,不返回带数据的旧 SSR 页。
          const cache = await caches.open(CACHE);
          return (await cache.match(OFFLINE_URL)) ?? Response.error();
        }),
      );
      return;
    }

    // cache-first(hashed 不可变):命中即用,否则取网络并入缓存。
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
  });
}
