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
// 选了币 → 用户那张票解出来的 ref 就是答案(#202b:表单交上来的是票,解票在服务端边界做,
// 见 server/internal/manual.ts)。**上游命名的 ref 在 mint 里本身就是锚** —— 不查映射表、
// 也不掉回 symbol 去猜。
// 没选 → 手记自己就是命名者 `manual/<SYMBOL>`,走 symbol 那一档,认不出来就自己一行。
// 两种都是规范 ref,没有「空着」这一档。
export function manualTokenRef(picked: { symbol: string; ref?: string | null }): string {
  return picked.ref || tokenRef.opaque(MANUAL_CONNECTOR_ID, picked.symbol.trim().toUpperCase());
}
