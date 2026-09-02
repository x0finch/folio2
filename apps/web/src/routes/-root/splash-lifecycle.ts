// 冷启动闪屏的生命周期判定(纯函数,测试缝 —— 照 sw-route 的做法)。
// React 组件只负责喂输入(hydrated / 路由是否 settle / 计时器)和渲染,时序决策全在这里,可穷举单测。

import splashConfig from "./splash-config.json";

export type SplashPhase = "preparing" | "loading" | "updating" | "exit";

export interface SplashInput {
  /** React 是否已在客户端挂载。SSR 首帧与 hydration 首渲为 false;mount effect 后 true。 */
  hydrated: boolean;
  /** 首个路由是否 settle(TanStack Router `status === "idle"`)。 */
  routerIdle: boolean;
  /** 最小可见时长(floor)是否已过 —— 免得快设备上一闪而过、动画等于没有。 */
  minElapsed: boolean;
  /** 硬超时是否已到(兜底放行,再慢也不把用户永远锁在闪屏)。 */
  maxElapsed: boolean;
  /** 是否正在应用新版本(更新路径;FOL-64 接线,本片恒 false)。 */
  updating: boolean;
}

/**
 * 当前该处在哪个阶段 / 是否放行。判定顺序即优先级:
 *   updating 无条件优先(换版时无论加载到哪都显示「更新中」)
 *   → 未 hydrate = SSR 首帧的「准备中」
 *   → 硬超时兜底放行
 *   → 骨架就位(路由 idle)且过了最短可见 → 放行
 *   → 否则还在「加载中」。
 */
export function splashPhase(i: SplashInput): SplashPhase {
  if (i.updating) return "updating";
  if (!i.hydrated) return "preparing";
  if (i.maxElapsed) return "exit";
  if (i.routerIdle && i.minElapsed) return "exit";
  return "loading";
}

/**
 * splash 静止 logo 的边长(px)。**单一来源在 splash-config.json**:iOS 启动图生成脚本
 * (gen-splash.mjs,纯 node 读不了 TS)与覆盖层样式(SPLASH_STYLE)同读它,让静态启动图里的 logo
 * 与随后呼吸 logo 的静止态(scale 1)大小一致 —— 静态→呼吸无缝交接。
 */
export const SPLASH_LOGO_SIZE: number = splashConfig.logoSize;

/** 每条阶段文案的最小可见时长(ms);放行至少等它。 */
export const SPLASH_MIN_MS = 700;
/** 硬超时(ms):再慢也放行。 */
export const SPLASH_MAX_MS = 8000;
/** 放大扩散退场动画时长(ms;与 SPLASH_STYLE 里的 keyframes 时长对齐)。 */
export const SPLASH_EXIT_MS = 520;
