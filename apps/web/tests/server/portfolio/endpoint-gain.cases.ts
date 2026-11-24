import { beforeEach, describe, expect, it } from "vitest";
import { floorToHour } from "@/lib/core/portfolio";
import { blockOutbound } from "../_kit/outbound";
import { readOverview } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// 24h P&L is now minus baseline, computed client-side in `overviewFromSnapshotData`. Rules:
//   · baseline = latest snapshot in [anchor-7d, anchor-24h]; anchor = now floored to the hour;
//   · no baseline (account < 24h old, or offline > 7 days) → that account contributes no P&L;
//   · new accounts/tokens still count fully toward the total (treated as deposits).
describe("portfolio/endpoint-gain", () => {
  const USER = "h-pf-endpoint-gain";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let ANCHOR = 0;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    ANCHOR = floorToHour(Date.now());
  });

  it("with a baseline → portfolio and holdings are now minus 24h ago", async () => {
    const acc = await seedAccount(USER, "钱包", "bitcoin");
    await seedSnapshot(USER, acc.id, ANCHOR - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

    const view = await readOverview(USER);
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
    expect(view.gain24h?.pct).toBeCloseTo(30, 6);
    const btc = view.holdings.find((h) => h.key === BTC);
    expect(btc?.gain24h?.amount).toBeCloseTo(30, 6);
    expect(btc?.gain24h?.pct).toBeCloseTo(30, 6);
  });

  it("whole portfolio created today (no baseline) → portfolio and holdings P&L null", async () => {
    const acc = await seedAccount(USER, "新号", "bitcoin");
    await seedSnapshot(USER, acc.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

    const view = await readOverview(USER);
    expect(view.gain24h).toBeNull();
    expect(view.holdings[0]?.gain24h).toBeNull();
  });

  it("whole portfolio offline > 7 days (no baseline) → portfolio and holdings P&L null", async () => {
    const acc = await seedAccount(USER, "断线", "bitcoin");
    await seedSnapshot(USER, acc.id, ANCHOR - 8 * DAY, [
      { tokenId: BTC, amount: 1, usdValue: 130 },
    ]);

    const view = await readOverview(USER);
    expect(view.gain24h).toBeNull();
    expect(view.holdings[0]?.gain24h).toBeNull();
  });

  it("new (no baseline) and old accounts mixed → only accounts with a baseline count", async () => {
    const old = await seedAccount(USER, "老号", "bitcoin");
    await seedSnapshot(USER, old.id, ANCHOR - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, old.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
    const fresh = await seedAccount(USER, "新号", "binance");
    await seedSnapshot(USER, fresh.id, ANCHOR, [{ tokenId: ETH, amount: 1, usdValue: 50 }]);

    const view = await readOverview(USER);
    // Portfolio P&L comes only from the old account: 130 − 100 = +30.
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
    expect(view.gain24h?.pct).toBeCloseTo(30, 6);
    // BTC has a baseline → +30; ETH exists only in the new account → null.
    expect(view.holdings.find((h) => h.key === BTC)?.gain24h?.amount).toBeCloseTo(30, 6);
    expect(view.holdings.find((h) => h.key === ETH)?.gain24h).toBeNull();
    // Both accounts still count toward the total.
    expect(view.totalUsd).toBeCloseTo(130 + 50, 6);
  });

  it("offline > 7 days (no baseline) → account contributes 0, portfolio not inflated", async () => {
    const live = await seedAccount(USER, "在线", "bitcoin");
    await seedSnapshot(USER, live.id, ANCHOR - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, live.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
    // Only snapshot is 8 days old (> 7 days) → no baseline.
    const stale = await seedAccount(USER, "断线", "binance");
    await seedSnapshot(USER, stale.id, ANCHOR - 8 * DAY, [
      { tokenId: ETH, amount: 10, usdValue: 5000 },
    ]);

    const view = await readOverview(USER);
    // P&L only from the live account (+30); the stale 5000 counts as neither baseline nor current.
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
    // The stale account's value still counts toward the total.
    expect(view.totalUsd).toBeCloseTo(130 + 5000, 6);
  });

  it("gap of a few days within the 7-day window → latest in-window snapshot is the baseline", async () => {
    const acc = await seedAccount(USER, "断了几天", "bitcoin");
    // One snapshot 3 days ago (inside [anchor-7d, anchor-24h]) + one now, none at exactly 24h.
    await seedSnapshot(USER, acc.id, ANCHOR - 3 * DAY, [{ tokenId: BTC, amount: 1, usdValue: 90 }]);
    await seedSnapshot(USER, acc.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 120 }]);

    const view = await readOverview(USER);
    // Baseline falls back to the 3-day-old 90; now 120 → +30.
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
  });
});
