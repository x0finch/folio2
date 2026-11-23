import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { TokenRecord } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "@/lib/core/account-view";
import { deriveLiveAccountTotals, liveValue } from "@/lib/core/portfolio";

const bal = (over: Partial<OverviewBalance>): OverviewBalance => {
  const symbol = over.symbol ?? "BTC";
  return {
    id: crypto.randomUUID(),
    symbol,
    amount: 0,
    usdValue: 0,
    kind: "spot",
    tokenId: `tk-${symbol}`,
    metaJson: null,
    ...over,
  };
};
const account = (id: string) =>
  ({
    id,
    label: id,
    connectorId: "manual",
    platform: null,
    archivedAt: null,
  }) as unknown as AccountSafe;
const snap = (accountId: string, balances: OverviewBalance[]) =>
  ({
    snapshot: { accountId, totalUsd: 0, takenAt: 1000 },
    balances,
  }) as unknown as SnapshotWithBalances;

describe("liveValue", () => {
  const b = (amount: number, usdValue: number, selfPrice?: number | null) =>
    ({ amount, usdValue, selfPrice }) as OverviewBalance;

  it("enrich-not-reprice self-first: uses own price (selfPrice), ignores source price", () => {
    expect(liveValue(b(2, 120000, 60000), 65000, "self-first")).toBe(120000);
  });

  it("mark-to-market row (selfPrice=null) self-first: takes live source price", () => {
    expect(liveValue(b(0.5, 30000, null), 65000, "self-first")).toBe(32500); // 0.5×65000
  });

  it("source-first: enrich-not-reprice also uses source price, own price kept as fallback", () => {
    expect(liveValue(b(2, 120000, 60000), 65000, "source-first")).toBe(130000); // 2×65000
  });

  it("source price missing + own price: own price as fallback", () => {
    expect(liveValue(b(2, 120000, 60000), undefined, "source-first")).toBe(120000);
  });

  it("source price missing + no own price: frozen usdValue as fallback", () => {
    expect(liveValue(b(0.5, 30000, null), undefined, "self-first")).toBe(30000);
  });
});

describe("deriveLiveAccountTotals", () => {
  const priceById: Record<string, number> = { "tk-BTC": 65000, "tk-USDC": 1 };
  const enrichedOf = (ids: readonly string[]): Map<string, TokenRecord> =>
    new Map(
      ids.map((id) => [
        id,
        {
          id,
          ref: "coingecko/issued:x",
          symbol: id.replace("tk-", ""),
          name: id,
          infoStale: false,
          price:
            priceById[id] === undefined
              ? undefined
              : { unitPrice: priceById[id], asOf: 0, stale: false },
        } as TokenRecord,
      ]),
    );

  it("self-first: enrich-not-reprice ≡ frozen, mark-to-market takes live source price", () => {
    const accounts = [account("cex"), account("wallet")];
    const byAccount = new Map<string, SnapshotWithBalances>([
      ["cex", snap("cex", [bal({ symbol: "BTC", amount: 2, usdValue: 120000, selfPrice: 60000 })])],
      [
        "wallet",
        snap("wallet", [bal({ symbol: "BTC", amount: 0.5, usdValue: 30000, selfPrice: null })]),
      ],
    ]);
    const totals = deriveLiveAccountTotals(
      accounts,
      byAccount,
      enrichedOf(["tk-BTC", "tk-USDC"]),
      "self-first",
    );
    expect(totals.get("cex")).toBe(120000);
    expect(totals.get("wallet")).toBe(32500);
    const grand = [...totals.values()].reduce((s, v) => s + v, 0);
    expect(grand).toBe(152500);
  });

  it("non-fungible row (fungibleId→null) takes no source price: self-first uses own price ≡ frozen", () => {
    const accounts = [account("defi")];
    const byAccount = new Map<string, SnapshotWithBalances>([
      [
        "defi",
        snap("defi", [bal({ symbol: "LP", kind: "defi", amount: 5, usdValue: 50, selfPrice: 10 })]),
      ],
    ]);
    const totals = deriveLiveAccountTotals(
      accounts,
      byAccount,
      enrichedOf(["tk-BTC", "tk-USDC"]),
      "self-first",
    );
    expect(totals.get("defi")).toBe(50);
  });
});
