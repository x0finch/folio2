import type { BalanceRawRow } from "@folio/db";
import { describe, expect, it } from "vitest";
import type { BalanceLike } from "@/lib/core/token-model";
import { userDisplayBalances } from "@/lib/core/token-model";

const snap = (accountId: string, tokenIds: string[]): BalanceRawRow[] =>
  tokenIds.map((tokenId, i) => [
    accountId,
    `${accountId}-${i}`,
    1,
    5,
    "spot",
    null,
    "evm:1",
    tokenId,
    null,
  ]);

const manual = (tokenId: string): BalanceLike => ({ kind: "spot", tokenId });

describe("userDisplayBalances", () => {
  it("merges snapshot balances with synthesized manual balances (both present)", () => {
    const out = userDisplayBalances(
      [...snap("cex", ["tk-btc"]), ...snap("wallet", ["tk-eth"])],
      [manual("tk-sol")],
    );
    expect(out.map((b) => b.tokenId)).toEqual(["tk-btc", "tk-eth", "tk-sol"]);
    expect(out[0]).toEqual({ kind: "spot", usdValue: 5, platform: "evm:1", tokenId: "tk-btc" });
  });

  it("no manual: snapshot balances only", () => {
    const out = userDisplayBalances(snap("cex", ["tk-btc"]), []);
    expect(out.map((b) => b.tokenId)).toEqual(["tk-btc"]);
  });

  it("manual-only user (no snapshot): set still contains manual (reachable by the refresh gate, so no idle refresh)", () => {
    const out = userDisplayBalances([], [manual("tk-eth")]);
    expect(out.map((b) => b.tokenId)).toEqual(["tk-eth"]);
  });
});
