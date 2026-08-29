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
    // 认定在写快照时定死(#201);测试里 id 用 `tk-<SYMBOL>`,好让富化字典按它供价。
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

  it("enrich-not-reprice self-first:用自带价(selfPrice),忽略源价", () => {
    // selfPrice=60000(= 同步时 value/amount);源价 65000 → self-first 仍 60000。
    expect(liveValue(b(2, 120000, 60000), 65000, "self-first")).toBe(120000);
  });

  it("盯市行(selfPrice=null)self-first:取实时源价", () => {
    expect(liveValue(b(0.5, 30000, null), 65000, "self-first")).toBe(32500); // 0.5×65000
  });

  it("source-first:enrich-not-reprice 也改用源价,自带价留作兜底", () => {
    expect(liveValue(b(2, 120000, 60000), 65000, "source-first")).toBe(130000); // 2×65000
  });

  it("源价缺 + 有自带价 → 自带兜底", () => {
    expect(liveValue(b(2, 120000, 60000), undefined, "source-first")).toBe(120000); // 回退 selfPrice
  });

  it("源价缺 + 无自带价 → 冻结 usdValue 兜底", () => {
    expect(liveValue(b(0.5, 30000, null), undefined, "self-first")).toBe(30000);
  });
});

describe("deriveLiveAccountTotals", () => {
  // 富化字典:BTC 现价 65000、USDC 1;其余无价(undefined)。按 token_id 供价(#201,cache-only)。
  // 现在是纯函数 —— 字典由调用方备好后传入,不再走 Effect / Oracle 桩。
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

  it("self-first:enrich-not-reprice ≡ 冻结,盯市取实时源价", () => {
    const accounts = [account("cex"), account("wallet")];
    const byAccount = new Map<string, SnapshotWithBalances>([
      // CEX:自带价权威(selfPrice=60000)→ 现推 = 冻结 120000。
      ["cex", snap("cex", [bal({ symbol: "BTC", amount: 2, usdValue: 120000, selfPrice: 60000 })])],
      // 盯市钱包:selfPrice=null → 取实时源价 65000 → 0.5×65000=32500(冻结曾是 30000)。
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

  it("非同质行(fungibleId→null)不取源价 → self-first 用自带价 ≡ 冻结", () => {
    const accounts = [account("defi")];
    const byAccount = new Map<string, SnapshotWithBalances>([
      // defi 行:fungibleId 返回 null(不取源价);selfPrice=10 → 5×10=50 ≡ 冻结。
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
