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
