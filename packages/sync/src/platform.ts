import { parseTokenRef } from "@folio/oracle-ref";

// 这笔持仓落在哪个 Platform(链 ∪ 场馆,见 CONTEXT.md)—— 写快照时算一次、落库,
// 读路径直接读那一列,**再不解析 tokenRef**(#176 的目标之一:apps/web 里 grep 不到 tokenRef)。
//
// 规则就一句:**平台 = tokenRef 的命名者**。链上持仓的命名者就是它所在的链(`evm:1` / `solana`),
// 场馆的命名者就是场馆本身(`binance` / `okx` / `hyperliquid`)—— 两者天然重合。
//
// 曾有过一条例外:价格源作命名者(手记选了币,ref 是 `coingecko/<id>`)→ 回落 connectorId。
// 随 #203 退场(手记快照改由 app 直算、不经本编排;`isSyncableAccount` 已把 manual 挡在 sync 外),
// 且 provider 报的 ref 命名者恒是位置(链 / 场馆)、永不是价格源 —— 那条分支到不了,#202 删。
export function platformOf(tokenRef: string, connectorId: string): string {
  const parsed = parseTokenRef(tokenRef);
  if (parsed.kind === "unknown") return connectorId;
  return parsed.namer;
}
