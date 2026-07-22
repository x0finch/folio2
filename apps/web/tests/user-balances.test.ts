import type { SnapshotWithBalances } from "@folio/db";
import { describe, expect, it } from "vitest";
import type { BalanceLike } from "../src/lib/tokens";
import { userDisplayBalances } from "../src/lib/user-balances";

const snap = (accountId: string, symbols: string[]): SnapshotWithBalances =>
  ({
    snapshot: { accountId, totalUsd: 0, takenAt: 1000 },
    balances: symbols.map((symbol) => ({ symbol, kind: "spot", tokenKey: null })),
  }) as unknown as SnapshotWithBalances;

const manual = (symbol: string, tokenKey: string | null): BalanceLike => ({
  symbol,
  kind: "spot",
  tokenKey,
});

// 三门同源收口:enrich/warm/refresh 必须喂同一集合。这些用例锁住「manual 合成余额一定在集合里」——
// 正是 T2 首版漏掉 refresh 门(#1)的回归防线。
describe("userDisplayBalances", () => {
  it("合并快照余额与 manual 合成余额(两者都在)", () => {
    const out = userDisplayBalances(
      [snap("cex", ["BTC"]), snap("wallet", ["ETH"])],
      [manual("SOL", "coingecko:solana")],
    );
    expect(out.map((b) => b.symbol)).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("无 manual → 只快照余额", () => {
    const out = userDisplayBalances([snap("cex", ["BTC"])], []);
    expect(out.map((b) => b.symbol)).toEqual(["BTC"]);
  });

  it("纯 manual 用户(无快照)→ 集合仍含 manual(refresh 门够得到 → 不会空转刷新)", () => {
    const out = userDisplayBalances([], [manual("ETH", "coingecko:ethereum")]);
    expect(out.map((b) => b.symbol)).toEqual(["ETH"]);
    expect(out[0].tokenKey).toBe("coingecko:ethereum");
  });
});
