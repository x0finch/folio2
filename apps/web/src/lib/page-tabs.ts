// 页内 tab 的合法值与回落规则(片5 / ADR 0043)。
//
// 为什么单独一个文件:这些是纯逻辑,而 route 文件一被 import 就会连带拉进服务端模块
// (`cloudflare:workers`),在单测的 logic 环境里直接炸。放这儿,route 与测试各自取用。
//
// **回落为什么必须由我们做**:实测 `@tanstack/react-router@1.170.16` 的 `validateSearch`
// 收窄的是**类型**、不过滤**值** —— 让它对 `?dim=bogus` 返回 `{}`,`useSearch()` 照样给回
// `"bogus"`(验证器确实跑了)。所以 route 上只声明形状,认不出的值在组件里 clamp。

import type { AllocDimension } from "./allocation";

// 首页三个「视角」tab 的名字全集。**不是当下有的那几个** —— 页面按数据有无收窄显示,
// 而这里回答的是「这是不是一个视角名」。自定义 Tab 的 pin id 是运行时数据,不在此列。
export const KIND_TABS = ["tokens", "perps", "defi"] as const;
export type KindTab = (typeof KIND_TABS)[number];

// 默认主 tab。它**不写进 URL** —— `/` 就是它,只有别的 tab 才挂 `?tab=`。
export const DEFAULT_TAB: KindTab = "tokens";

// 该显示哪个 tab。三态判断,抽成纯函数是为了能测 —— 它兼着两件长得像但成因不同的事:
//   · **pin 还没挂上**(刚建完 pin,invalidate 已 resolve 但新数据还没到组件):`requested`
//     认不出、`lastKnown` 认得出 → 停在 lastKnown,药丸不闪回第一个 tab。
//   · **pin 不存在了**(URL 里带着被删的 pin id,或手写乱码):两个都认不出 → 回落默认 tab。
export function pickShownTab(
  requested: string,
  lastKnown: string,
  isKnown: (v: string) => boolean,
): string {
  if (isKnown(requested)) return requested;
  if (isKnown(lastKnown)) return lastKnown;
  return DEFAULT_TAB;
}

// Insights 的分布维度:合法值是**有限集**(与首页的 pin id 不同),所以能在这里判死。
//
// 从一张穷尽的 `Record` 派生而不是直接写数组:数组配 `satisfies` 只能保证「写进去的都合法」,
// **保证不了「合法的都写进去了」** —— `AllocDimension` 将来多一个成员,数组少一项不报错,
// 那个维度就只是悄悄不出现在 tab 条里。`Record` 少一个键编译期直接红。
const DIMENSION_SET: Record<AllocDimension, true> = { token: true, chain: true, account: true };
export const ALLOC_DIMENSIONS = Object.keys(DIMENSION_SET) as AllocDimension[];
export const DEFAULT_DIM: AllocDimension = "token";

export function isDimension(v: unknown): v is AllocDimension {
  return typeof v === "string" && v in DIMENSION_SET;
}
