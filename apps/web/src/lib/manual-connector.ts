import type { ConnectorId } from "@folio/connectors";

// manual connector 的 id —— app 侧「是不是 manual 账户」判别的**单一事实源**。
// manual = 值靠 creds 现造、不联网同步的账户(ADR 0018);Q2 决定用 app 侧写死判别而非 manifest 能力位,
// 故散落各处的 connectorId === "manual" 全收此,避免字面量遍地。
export const MANUAL_CONNECTOR_ID = "manual" satisfies ConnectorId;

export function isManual(connectorId: ConnectorId): boolean {
  return connectorId === MANUAL_CONNECTOR_ID;
}
