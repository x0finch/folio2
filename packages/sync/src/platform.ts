import { CGK_VENDOR } from "@folio/oracle-basic";
import { parseTokenRef } from "@folio/oracle-ref";

// 这笔持仓落在哪个 Platform(链 ∪ 场馆,见 CONTEXT.md)—— 写快照时算一次、落库,
// 读路径直接读那一列,**再不解析 tokenRef**(#176 的目标之一:apps/web 里 grep 不到 tokenRef)。
//
// 规则就一句:**平台 = tokenRef 的命名者**。链上持仓的命名者就是它所在的链(`evm:1` / `solana`),
// 场馆的命名者就是场馆本身(`binance` / `okx` / `hyperliquid`)—— 两者天然重合。
//
// 唯一的例外是**价格源作命名者**:手记用户选了币,ref 是 `coingecko/<id>`,那是「谁管它叫什么」
// 而不是「它在哪」。这种回落到账户的 connectorId(手记的位置就是 `manual`)。
// 例外只此一条,而且随手记 provider 一起退场(#203:手记快照行改由 app 直算)。
export function platformOf(tokenRef: string, connectorId: string): string {
  const parsed = parseTokenRef(tokenRef);
  if (parsed.kind === "unknown" || parsed.namer === CGK_VENDOR) return connectorId;
  return parsed.namer;
}
