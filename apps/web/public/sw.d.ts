// public/sw.js 的类型声明(sidecar):让 .ts 单测能类型安全地 import 手搓 SW 的纯函数,
// 而无需给整个 app 开 allowJs(会连累 tsc 去读别处的 vendor .cjs)。SW 事件那半无需声明
// —— 单测只碰 swRoute。
export type SwStrategy = "navigation" | "cache-first" | "network-only";

export interface SwRequestShape {
  method: string;
  mode: string;
  destination: string;
  sameOrigin: boolean;
  pathname: string;
}

export function swRoute(req: SwRequestShape): SwStrategy;

// cache-first 的第二道门(sw.js 里有全文注释):响应内容类型要与 destination 对得上才进缓存。
export function isCacheableAsset(destination: string, contentType: string | null): boolean;
