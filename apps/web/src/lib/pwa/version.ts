// 版本比对的纯函数缝(ADR 0051 的「诚实·联网总是最新」模型;测试缝,照 sw-route / 旧 update-action)。
// 副作用(fetch / toast / reload)留在 service-worker.ts,这里只做「从 sw.js 文本里取版本」「判断线上
// 是否比当前更新」两件可穷举单测的纯逻辑。

// 构建期 vite 的 stampSwVersion 会把 public/sw.js 里的 `// @sw-build __SW_BUILD__` 换成 git describe
// 版本号。dev/未构建时保持占位原文 —— 那不是一个真版本,按「无」处理。
const SW_BUILD_PLACEHOLDER = "__SW_BUILD__";

/** 从线上 sw.js 源码里取出戳进去的构建版本(`@sw-build <ver>` 那行);取不到返回 null。 */
export function parseSwBuild(swSource: string): string | null {
  return swSource.match(/@sw-build\s+(\S+)/)?.[1] ?? null;
}

/**
 * 线上版本是否比当前在跑的更新 —— 即「有得可更新」。判据是**版本号不同**(不是 SW 的 waiting 状态):
 * network-first 下冷启动拿到的就是最新,只有会话开着期间上游换了版,已加载的 `running` 才会落后于线上
 * 的 `deployed`。占位(未构建)与空串按「无新版」处理,免得 dev / 解析失败时误报。
 */
export function isNewerVersion(deployed: string | null, running: string): boolean {
  if (!deployed || deployed === SW_BUILD_PLACEHOLDER) return false;
  if (!running || running === "dev") return false;
  return deployed !== running;
}

// 本次加载**实际在跑**的构建版本(打包期 vite 的 define 注入的全局,与 sw.js 的 `@sw-build` 同源)。
// typeof 守卫:vitest 不套 define,本模块经 service-worker / user-card 被测试传入,裸引 `__APP_VERSION__`
// 会 ReferenceError → 退到 "dev"(`isNewerVersion` 也把 "dev" 当「无新版」,不会误报)。
export const RUNNING_VERSION = typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__;

/** 展示用:去掉 git describe 的 `-g<hash>` 后缀,留 `v0.14.0-27` 这样的形状(无 tag 的短 hash 原样返回)。 */
export function stripBuildHash(version: string): string {
  return version.replace(/-g[0-9a-f]+$/i, "");
}
