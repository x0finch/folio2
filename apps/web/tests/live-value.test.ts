import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Tokens } from "@folio/oracle";
import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "../src/lib/account-view";
import { deriveLiveAccountTotals, liveValue } from "../src/lib/live-value";

const bal = (over: Partial<OverviewBalance>): OverviewBalance => {
  const symbol = over.symbol ?? "BTC";
  return {
    id: crypto.randomUUID(),
    symbol,
    amount: 0,
    usdValue: 0,
    kind: "spot",
    // 认定在写快照时定死(#201);测试里 id 用 `tk-<SYMBOL>`,好让假 tokens 按它供价。
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
  // 假 tokens:BTC 现价 65000、USDC 1;其余无价(undefined)。按 symbol 供源价(cache-only)。
  // 按 token_id 供价(#201):测试里 id 直接用 `tk-<SYMBOL>`。
  const priceById: Record<string, number> = { "tk-BTC": 65000, "tk-USDC": 1 };
  const tokens = {
    async enrich(ids: readonly string[]) {
      return new Map(
        ids.map((id) => [
          id,
          {
            id,
            ref: "coingecko/issued:x",
            symbol: id.replace("tk-", ""),
            name: id,
            price:
              priceById[id] === undefined
                ? undefined
                : { unitPrice: priceById[id], asOf: 0, stale: false },
          },
        ]),
      );
    },
  } as unknown as Tokens;

  it("self-first:enrich-not-reprice ≡ 冻结,盯市取实时源价", async () => {
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
    const totals = await deriveLiveAccountTotals(accounts, byAccount, tokens, "self-first");
    expect(totals.get("cex")).toBe(120000);
    expect(totals.get("wallet")).toBe(32500);
    const grand = [...totals.values()].reduce((s, v) => s + v, 0);
    expect(grand).toBe(152500);
  });

  it("非同质行(balanceToAssetRef→null)不取源价 → self-first 用自带价 ≡ 冻结", async () => {
    const accounts = [account("defi")];
    const byAccount = new Map<string, SnapshotWithBalances>([
      // defi_position:enrich 返 undefined(源价无);selfPrice=10 → 5×10=50 ≡ 冻结。
      [
        "defi",
        snap("defi", [
          bal({ symbol: "LP", kind: "defi_position", amount: 5, usdValue: 50, selfPrice: 10 }),
        ]),
      ],
    ]);
    const totals = await deriveLiveAccountTotals(accounts, byAccount, tokens, "self-first");
    expect(totals.get("defi")).toBe(50);
  });
});
