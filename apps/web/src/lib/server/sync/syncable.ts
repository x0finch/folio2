import type { AccountSafe } from "@folio/db";
import { isManual } from "@/lib/core/manual";

// 可同步账户判别(纯逻辑,无 server import → 可单测)。
// 活跃(未归档)且**不是 manual** —— manual 不是同步源:当下值实时由 creds.tokens 现造、不写快照(ADR 0018)。
export function isSyncableAccount(a: Pick<AccountSafe, "archivedAt" | "connectorId">): boolean {
  return a.archivedAt == null && !isManual(a.connectorId);
}
