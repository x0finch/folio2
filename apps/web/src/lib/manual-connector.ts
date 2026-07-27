import type { ConnectorId } from "@folio/connectors";
import { tokenRef } from "@folio/oracle-ref";

// manual connector 的 id —— app 侧「是不是 manual 账户」判别的**单一事实源**。
// manual = 值靠 creds 现造、不联网同步的账户(ADR 0018);Q2 决定用 app 侧写死判别而非 manifest 能力位,
// 故散落各处的 connectorId === "manual" 全收此,避免字面量遍地。
export const MANUAL_CONNECTOR_ID = "manual" satisfies ConnectorId;

export function isManual(connectorId: ConnectorId): boolean {
  return connectorId === MANUAL_CONNECTOR_ID;
}

// 手记持仓 → tokenRef(#203 起住在 app;原来在已删除的 manual provider 包里)。
//
// 选了币 → 厂商寻址 `coingecko/<id>`(上游 coin id 规范为小写 kebab,归一在生产者侧做);
// 没选 → 手记自己就是命名者 `manual/<SYMBOL>`。两种都是规范 ref,没有「空着」这一档。
//
// **`coingecko/<id>` 形的 ref 在 mint 里本身就是锚**(它已经是上游的命名)→ 用户选了币就等于
// 直接给出答案,不查映射表也不掉回 symbol 去猜。没选币的走 symbol 那一档,认不出来就自己一行。
export function manualTokenRef(picked: { symbol: string; identifier?: string | null }): string {
  return picked.identifier
    ? tokenRef.opaque("coingecko", picked.identifier.trim().toLowerCase())
    : tokenRef.opaque(MANUAL_CONNECTOR_ID, picked.symbol.trim().toUpperCase());
}
