import type { AccountSafe } from "@folio/db";
import { describe, expect, it } from "vitest";
import { accountSyncStatus, isSyncableAccount, STALE_SYNC_MS } from "@/lib/server/sync/status";

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("accountSyncStatus", () => {
  it("缺凭据优先(即便刚同步过)→ needsCreds", () => {
    expect(accountSyncStatus({ needsCredentials: true, takenAt: NOW - HOUR }, NOW)).toBe(
      "needsCreds",
    );
  });

  it("无快照(takenAt=null)且不缺凭据 → never", () => {
    expect(accountSyncStatus({ needsCredentials: false, takenAt: null }, NOW)).toBe("never");
  });

  it("同步过久(超阈值)→ stale", () => {
    expect(
      accountSyncStatus({ needsCredentials: false, takenAt: NOW - STALE_SYNC_MS - 1 }, NOW),
    ).toBe("stale");
  });

  it("近期同步(阈值内)→ fresh", () => {
    expect(accountSyncStatus({ needsCredentials: false, takenAt: NOW - HOUR }, NOW)).toBe("fresh");
  });

  it("恰好在阈值边界(= 阈值)→ 仍 fresh(严格超过才算陈旧)", () => {
    expect(accountSyncStatus({ needsCredentials: false, takenAt: NOW - STALE_SYNC_MS }, NOW)).toBe(
      "fresh",
    );
  });

  it("阈值为 3 天 —— 账户行与页头面板共用这一个", () => {
    // 曾经是 24 小时。改成 3 天有两个理由:同步是手动动作,隔一天不点很正常;而这个阈值现在
    // 也决定页头徽标变不变琥珀,24 小时会让它几乎天天在提醒。
    expect(STALE_SYNC_MS).toBe(3 * 24 * HOUR);
  });
});

type A = Pick<AccountSafe, "archivedAt" | "connectorId">;
const a = (over: Partial<A>): A => ({ archivedAt: null, connectorId: "bitcoin", ...over });

describe("isSyncableAccount", () => {
  it("活跃的非-manual 账户可同步", () => {
    expect(isSyncableAccount(a({ connectorId: "bitcoin" }))).toBe(true);
    expect(isSyncableAccount(a({ connectorId: "evm" }))).toBe(true);
  });

  it("manual 不是同步源(ADR 0018)→ 排除", () => {
    expect(isSyncableAccount(a({ connectorId: "manual" }))).toBe(false);
  });

  it("归档账户排除(即便非 manual)", () => {
    expect(isSyncableAccount(a({ connectorId: "bitcoin", archivedAt: 123 }))).toBe(false);
  });
});
