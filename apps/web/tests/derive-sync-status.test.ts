import { describe, expect, it } from "vitest";
import { deriveSyncStatus } from "@/lib/core/sync-summary";
import type { AccountListItem } from "@/lib/queries/accounts";
import type { AccountSnapshot } from "@/lib/server/portfolio/snapshots";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const BTC = "token-btc";

const account = (over: Partial<AccountListItem> = {}): AccountListItem =>
  ({
    id: "a1",
    label: "CEX",
    connectorId: "binance",
    archivedAt: null,
    needsCredentials: false,
    portfolioId: "pf-1",
    credsSafe: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as AccountListItem;

const snapshot = (accountId: string, takenAt: number): AccountSnapshot => ({
  accountId,
  takenAt,
  totalUsd: 100,
  balances: [{ id: "b1", amount: 1, usdValue: 100, kind: "token", tokenId: BTC, metaJson: null }],
});

describe("deriveSyncStatus", () => {
  it("缺凭据、数旧了都进「需要注意」", () => {
    const accounts = [
      account({ id: "fresh", label: "刚同步" }),
      account({ id: "stale", label: "很久没同步" }),
      account({ id: "creds", label: "缺凭据", needsCredentials: true }),
    ];
    const snapshots = [snapshot("fresh", NOW), snapshot("stale", NOW - 30 * DAY)];
    const out = deriveSyncStatus(accounts, snapshots, NOW);

    expect(out.total).toBe(3);
    expect(out.attention.map((a) => [a.label, a.kind])).toEqual([
      ["缺凭据", "missing-credentials"],
      ["很久没同步", "stale"],
    ]);
    expect(out.lastSyncedAt).toBe(NOW);
  });

  it("从没同步过的账户 → 上次同步时刻是空,不是 1970", () => {
    const out = deriveSyncStatus([account({ id: "never", label: "没同步过" })], [], NOW);

    expect(out.lastSyncedAt).toBeNull();
    expect(out.attention.map((a) => a.kind)).toEqual(["never-synced"]);
  });

  it("只含当前组合的账户行(调用方已按组合筛好)", () => {
    const accounts = [
      account({ id: "mine", label: "在默认里" }),
      account({ id: "theirs", label: "在 Watch 里" }),
    ];
    const out = deriveSyncStatus([accounts[0]!], [], NOW);

    expect(out.accounts.map((a) => a.id)).toEqual(["mine"]);
    expect(out.total).toBe(1);
  });
});
