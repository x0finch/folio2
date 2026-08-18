import { type DefiGroup, mergeDefiGroups } from "../../core/account-view";

// 首页 tab 条轻请求的两份纯推导:有没有永续/DeFi、pin 显示成什么。
// 放 internal:只有 `getHomeTabStrip` 用,客户端拿的是算好的结果。
// 页面侧的 tab 回落见 `routes/_authed/-home/home-tabs`。

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
