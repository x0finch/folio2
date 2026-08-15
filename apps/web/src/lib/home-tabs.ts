import { type DefiGroup, mergeDefiGroups } from "./account-view";
import type { PinScopeKey } from "./queries/keys";

// 首页主 tab 的合法值与回落规则(片5 / ADR 0043)。
//
// **为什么单独一个文件**:`pickShownTab` 要被单测钉住,而从 route 文件 import 任何东西都会连带
// 拉进服务端模块(`cloudflare:workers`),在单测的 logic 环境里直接炸。
//
// 只装首页的东西。Insights 那个 `?dim=` 曾经也堆在这儿,但它围着 `AllocDimension` 转,已经回到
// `lib/allocation.ts` —— 那是那个类型的老家,而且它的校验器就是那份 zod schema 本身。

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

// 和总览画面同一套「算不算有永续 / DeFi」:有仓位或权益才出永续 tab;DeFi 跨账户合并后还有组才出。
// 入参就是 `toAccountSections` 的出口,轻请求和列表共用,tab 条才不会在数据到齐后跳一下。
type KindSection = {
  perp: { positions: readonly unknown[]; equity: unknown } | null;
  defi: DefiGroup[];
};

export function kindPresence(sections: KindSection[]): {
  hasPerps: boolean;
  hasDefi: boolean;
} {
  return {
    hasPerps: sections.some(
      (s) => s.perp != null && (s.perp.positions.length > 0 || s.perp.equity != null),
    ),
    hasDefi: mergeDefiGroups(sections).length > 0,
  };
}

// 自定义 Tab 的显示名(+ connector 的图):服务端解析好再下发,客户端不再为了渲染 tab 名去拉目录。
// `#` / `@` 不进这里 —— 那是展示前缀,渲染时按 kind 加上。
export function resolvePinLabel(
  pin: {
    kind: "connector" | "tag" | "account";
    connectorId?: string | null;
    tagId?: string | null;
    accountId?: string | null;
  },
  lookup: {
    tagName: (id: string) => string | undefined;
    accountName: (id: string) => string | undefined;
    connector: (id: string) => { name: string; logo?: string };
  },
): { name: string; logo?: string } {
  if (pin.kind === "tag") return { name: lookup.tagName(pin.tagId ?? "") ?? "" };
  if (pin.kind === "account") return { name: lookup.accountName(pin.accountId ?? "") ?? "" };
  const c = lookup.connector(pin.connectorId ?? "");
  return c.logo ? { name: c.name, logo: c.logo } : { name: c.name };
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
