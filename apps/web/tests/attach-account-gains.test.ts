import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "@/lib/core/account-view";
import { attachAccountHoldingGains, type PrevSlice } from "@/lib/core/portfolio";

// Per-token P&L in the account sheet: with a baseline (prev != null) → endpoint subtraction, spread over
// spot rows by value share; without one → null (—). Only fungible spot rows with a token_id count.

const LIDO = JSON.stringify({ protocol: "Lido", positionType: "staked" });

// A row of the baseline group (viewKind reads only kind/metaJson).
const pb = (over: Partial<OverviewBalance>): OverviewBalance => ({
  id: crypto.randomUUID(),
  symbol: "S",
  amount: 1,
  usdValue: 0,
  kind: "spot",
  tokenId: "shared",
  metaJson: null,
  ...over,
});

const prevOf = (accountId: string, balances: OverviewBalance[]): ReadonlyMap<string, PrevSlice> =>
  new Map([[accountId, { snapshot: { takenAt: 0 }, balances }]]);

// Account row with one spot and one DeFi row of the same token_id.
const mixedRow = (totalUsd: number, archivedAt: number | null = null) => ({
  account: { id: "a" },
  archivedAt,
  totalUsd,
  balances: [
    { id: "spot", tokenId: "shared", amount: 1, usdValue: 110, kind: "spot" },
    { id: "defi", tokenId: "shared", amount: 1, usdValue: 500, kind: "defi", metaJson: LIDO },
  ],
});

describe("attachAccountHoldingGains", () => {
  it("baseline: token with spot and DeFi rows → spot P&L uses spot endpoints only, not inflated by DeFi", () => {
    const prev = prevOf("a", [
      pb({ tokenId: "shared", usdValue: 100, kind: "spot" }),
      pb({ tokenId: "shared", usdValue: 480, kind: "defi", metaJson: LIDO }),
    ]);

    const [out] = attachAccountHoldingGains([mixedRow(610)], prev);

    // Account level: all balances, 610 − 580 = +30.
    expect(out!.gain24h?.amount).toBeCloseTo(30, 6);
    // Spot row: start 100 → now 110 (spot only, DeFi's 500 excluded) → +10.
    const spot = out!.balances.find((b) => b.id === "spot");
    expect(spot?.gain24h?.amount).toBeCloseTo(10, 6);
    expect(spot?.gain24h?.pct).toBeCloseTo(10, 6);
    // The bug: now-value counted as 110+500=610, spreading +510 to the spot row ≈ +91.8.
    expect(spot?.gain24h?.amount).not.toBeCloseTo(91.8, 1);
    // DeFi row isn't spot → per-row P&L omitted (the DeFi section shows it).
    expect(out!.balances.find((b) => b.id === "defi")?.gain24h).toBeUndefined();
  });

  it("baseline, but the token wasn't held 24h ago → start 0, full current value counts (bought today)", () => {
    // The account has a baseline (other tokens); only this token starts at 0 — not the same as no baseline.
    const prev = prevOf("a", [pb({ tokenId: "other", usdValue: 50, kind: "spot" })]);
    const [out] = attachAccountHoldingGains([mixedRow(160)], prev);
    const spot = out!.balances.find((b) => b.id === "spot");
    expect(spot?.gain24h?.amount).toBeCloseTo(110, 6); // start 0 → +current value
    expect(spot?.gain24h?.pct).toBeNull(); // zero denominator
  });

  // No baseline (new account / new manual / offline over 7 days) is always —, no new/stale distinction.
  it("no baseline (empty start group) → account null, spot rows null (—), non-spot undefined", () => {
    const [out] = attachAccountHoldingGains([mixedRow(110)], new Map());
    expect(out!.gain24h).toBeNull();
    expect(out!.balances.find((b) => b.id === "spot")?.gain24h).toBeNull();
    expect(out!.balances.find((b) => b.id === "defi")?.gain24h).toBeUndefined();
  });

  it("archived account → both levels omitted (undefined)", () => {
    const [out] = attachAccountHoldingGains([mixedRow(110, 1)], new Map());
    expect(out!.gain24h).toBeUndefined();
    expect(out!.balances.find((b) => b.id === "spot")?.gain24h).toBeUndefined();
  });
});

// A token whose current value is 0 but was 300 a day ago: value-share weights have a zero denominator,
// so split evenly — otherwise the −300 vanishes from the rows and they no longer sum to the account.
describe("attachAccountHoldingGains — token whose value dropped to zero", () => {
  it("two rows both worth 0, start 300 → −150 each, summing to the token's −300", () => {
    const [row] = attachAccountHoldingGains(
      [
        {
          account: { id: "a" },
          archivedAt: null,
          totalUsd: 0,
          balances: [
            { id: "eth-arb", tokenId: "eth", amount: 0, usdValue: 0, kind: "spot" },
            { id: "eth-op", tokenId: "eth", amount: 0, usdValue: 0, kind: "spot" },
          ],
        },
      ],
      prevOf("a", [pb({ tokenId: "eth", usdValue: 300 })]),
    );
    expect(row?.balances.map((b) => b.gain24h?.amount)).toEqual([-150, -150]);
    expect(row?.gain24h?.amount).toBe(-300);
  });
});
