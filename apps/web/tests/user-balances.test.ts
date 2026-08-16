import type { SnapshotWithBalances } from "@folio/db";
import { describe, expect, it } from "vitest";
import type { BalanceLike } from "../src/lib/core/tokens";
import { userDisplayBalances } from "../src/lib/core/tokens";

// 身份走 token_id(#243:symbol / tokenRef 不再落快照,显示名住 Token 那一行)。
const snap = (accountId: string, tokenIds: string[]): SnapshotWithBalances =>
  ({
    snapshot: { accountId, totalUsd: 0, takenAt: 1000 },
    balances: tokenIds.map((tokenId) => ({ tokenId, kind: "spot" })),
  }) as unknown as SnapshotWithBalances;

const manual = (tokenId: string): BalanceLike => ({ kind: "spot", tokenId });

// 三门同源收口:enrich/warm/refresh 必须喂同一集合。这些用例锁住「manual 合成余额一定在集合里」——
// 正是 T2 首版漏掉 refresh 门(#1)的回归防线。
describe("userDisplayBalances", () => {
  it("合并快照余额与 manual 合成余额(两者都在)", () => {
    const out = userDisplayBalances(
      [snap("cex", ["tk-btc"]), snap("wallet", ["tk-eth"])],
      [manual("tk-sol")],
    );
    expect(out.map((b) => b.tokenId)).toEqual(["tk-btc", "tk-eth", "tk-sol"]);
  });

  it("无 manual → 只快照余额", () => {
    const out = userDisplayBalances([snap("cex", ["tk-btc"])], []);
    expect(out.map((b) => b.tokenId)).toEqual(["tk-btc"]);
  });

  it("纯 manual 用户(无快照)→ 集合仍含 manual(refresh 门够得到 → 不会空转刷新)", () => {
    const out = userDisplayBalances([], [manual("tk-eth")]);
    expect(out.map((b) => b.tokenId)).toEqual(["tk-eth"]);
  });
});
