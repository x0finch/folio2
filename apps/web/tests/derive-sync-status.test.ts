import { describe, expect, it } from "vitest";
import type { AccountSnapshotEntry as AccountSnapshot } from "@/lib/core/portfolio";
import { deriveSyncStatus } from "@/lib/core/sync-summary";
import type { AccountListItem } from "@/lib/queries/accounts";

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
  it("missing creds and stale data both need attention", () => {
    const accounts = [
      account({ id: "fresh", label: "Just synced" }),
      account({ id: "stale", label: "Long unsynced" }),
      account({ id: "creds", label: "Missing creds", needsCredentials: true }),
    ];
    const snapshots = [snapshot("fresh", NOW), snapshot("stale", NOW - 30 * DAY)];
    const out = deriveSyncStatus(accounts, snapshots, NOW);

    expect(out.total).toBe(3);
    expect(out.attention.map((a) => [a.label, a.kind])).toEqual([
      ["Missing creds", "missing-credentials"],
      ["Long unsynced", "stale"],
    ]);
    expect(out.lastSyncedAt).toBe(NOW);
  });

  it("never-synced account → last sync time is null, not 1970", () => {
    const out = deriveSyncStatus([account({ id: "never", label: "Never synced" })], [], NOW);

    expect(out.lastSyncedAt).toBeNull();
    expect(out.attention.map((a) => a.kind)).toEqual(["never-synced"]);
  });
});
