import type { PinScopeKey } from "../../../lib/queries/keys";

// 首页主 tab 的合法值与回落规则(片5 / ADR 0043)。
//
// 纯文件,不引 route API:`pickShownTab` 要被单测钉住,而 `tab/selection.ts` 会拉进
// `getRouteApi`,在单测的 logic 环境里直接炸。
//
// 只装页面侧的东西。轻请求用的「算不算有永续 / DeFi」和 pin 显示名在
// `lib/server/internal/tab-strip` —— 只有服务端用,客户端拿的是算好的结果。

// 首页三个「视角」tab 的名字全集。**不是当下有的那几个** —— 页面按数据有无收窄显示,
// 而这里回答的是「这是不是一个视角名」。自定义 Tab 的 pin id 是运行时数据,不在此列。
export const KIND_TABS = ["tokens", "perps", "defi"] as const;
export type KindTab = (typeof KIND_TABS)[number];

// 默认主 tab。它**不写进 URL** —— `/` 就是它,只有别的 tab 才挂 `?tab=`(由 `stripSearchParams`
// 在建地址时统一剥掉)。
export const DEFAULT_TAB: KindTab = "tokens";

// 该显示哪个 tab。三态判断,抽成纯函数是为了能测 —— 它兼着两件长得像但成因不同的事:
//   · **pin 还没挂上**(刚建完 pin,invalidate 已 resolve 但新数据还没到组件):`requested`
//     认不出、`lastKnown` 认得出 → 停在 lastKnown,药丸不闪回第一个 tab。
//   · **pin 不存在了**(URL 里带着被删的 pin id,或手写乱码):两个都认不出 → 回落默认 tab。
//
// 这一段**不能**搬进 route 的 `validateSearch`(Insights 的维度就是那么做的):合法值里有
// 自定义 Tab 的 pin id,是运行时数据,route 层根本不知道有哪些,更分不出上面这两种情况。
export function pickShownTab(
  requested: string,
  lastKnown: string,
  isKnown: (v: string) => boolean,
): string {
  if (isKnown(requested)) return requested;
  if (isKnown(lastKnown)) return lastKnown;
  return DEFAULT_TAB;
}

// 三个视角 tab 谁出现:Tokens 恒在,永续 / DeFi 有货才挂。顺序固定,和今天画面上的一样。
// 首页 tab 条用轻请求给的两个布尔值来算,不再等总览拆完 sections —— 列表后到时 tab 不能再增删。
export function kindTabsOf(hasPerps: boolean, hasDefi: boolean): KindTab[] {
  const tabs: KindTab[] = ["tokens"];
  if (hasPerps) tabs.push("perps");
  if (hasDefi) tabs.push("defi");
  return tabs;
}

// 取消当前 pin 之后药丸停在哪。不能靠 URL 回落(`pickShownTab` 会滑回 Tokens);要回**左邻**:
// 前一个 pin,没有则最后一个视角 tab。
export function tabAfterUnpin(
  pinId: string,
  pins: readonly { id: string }[],
  kindTabs: readonly KindTab[],
): string {
  const idx = pins.findIndex((p) => p.id === pinId);
  return idx > 0 ? pins[idx - 1].id : kindTabs[kindTabs.length - 1];
}

export function pinScopeOf(pin: {
  kind: "connector" | "tag" | "account";
  connectorId?: string | null;
  tagId?: string | null;
  accountId?: string | null;
}): PinScopeKey {
  if (pin.kind === "tag") return { kind: "tag", tagId: pin.tagId ?? undefined };
  if (pin.kind === "account") return { kind: "account", accountId: pin.accountId ?? undefined };
  return { kind: "connector", connectorId: pin.connectorId ?? undefined };
}
