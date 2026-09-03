// 冷启动闪屏的生命周期判定(纯函数,测试缝 —— 照 sw-route 的做法)。
// React 组件只负责喂输入(hydrated / 路由是否 settle / 计时器)和渲染,时序决策全在这里,可穷举单测。
// 也是闪屏几个**共享常量**的家:被 splash.tsx 与 pwa-head.ts(内联 SPLASH_STYLE)同用。

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

/** splash 呼吸 logo 的边长(px)。 */
export const SPLASH_LOGO_SIZE = 88;

// 品牌明暗底色(beUI 的 `--background`:亮 lab(98.84%)≈#fcfcfc、暗 #151515)。**单一来源在这**:
// SPLASH_STYLE 的覆盖层 + html 底色、theme-color meta(见 pwa-head)同用。曾放 splash-config.json 是为了
// 让纯 node 的启动图生成脚本同读;那套已删,收回 TS 常量。
export const SPLASH_COLOR_DARK = "#151515";
export const SPLASH_COLOR_LIGHT = "#fcfcfc";

/** 每条阶段文案的最小可见时长(ms);放行至少等它。 */
export const SPLASH_MIN_MS = 700;
/** 硬超时(ms):再慢也放行。 */
export const SPLASH_MAX_MS = 8000;
/** 放大扩散退场动画时长(ms;与 SPLASH_STYLE 里的 keyframes 时长对齐)。 */
export const SPLASH_EXIT_MS = 520;
