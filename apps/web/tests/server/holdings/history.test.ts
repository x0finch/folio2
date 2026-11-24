import { beforeEach, describe, expect, it } from "vitest";
import { tokenValueHistoryFromRaw } from "@/lib/core/portfolio";
import { handleGetTokenValueHistory, TokenValueHistoryInput } from "@/lib/server/holdings/history";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// The curve is keyed by tokenId and includes only `kind === "spot"` rows.
const USER = "h-holdings-history";
const BTC = "token-btc";
const NOW = 1_770_000_000_000; // fixed clock: every case is about relative time

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

const curve = async (input: { key: string; since?: number }) => {
  const raw = await call(USER, handleGetTokenValueHistory(input));
  return tokenValueHistoryFromRaw(raw);
};

describe("getTokenValueHistory", () => {
  it("same token across three accounts → each point is their sum", async () => {
    const a = await seedAccount(USER, "甲");
    const b = await seedAccount(USER, "乙");
    const c = await seedAccount(USER, "丙");
    for (const [acc, value] of [
      [a, 100],
      [b, 200],
      [c, 300],
    ] as const) {
      await seedSnapshot(USER, acc.id, NOW - DAY, [{ tokenId: BTC, amount: 1, usdValue: value }]);
    }

    const series = await curve({ key: BTC });

    expect(series).toHaveLength(1);
    expect(series[0].total).toBe(600);
  });

  it("with since → only points inside the window", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW - 10 * DAY, [{ tokenId: BTC, amount: 1, usdValue: 10 }]);
    await seedSnapshot(USER, acc.id, NOW - DAY, [{ tokenId: BTC, amount: 1, usdValue: 20 }]);

    const series = await curve({ key: BTC, since: NOW - 2 * DAY });

    expect(series.map((p) => p.total)).toEqual([20]);
  });

  it("key matches no holding → empty curve, not an error", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const series = await curve({ key: "token-doge" });

    expect(series).toEqual([]);
  });

  it("other users' snapshots stay out of my curve", async () => {
    const theirs = await seedAccount(otherUser(USER), "他们的");
    await seedSnapshot(otherUser(USER), theirs.id, NOW, [
      { tokenId: BTC, amount: 1, usdValue: 999 },
    ]);
    const mine = await seedAccount(USER, "甲");
    await seedSnapshot(USER, mine.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const series = await curve({ key: BTC });

    expect(series.at(-1)?.total).toBe(100);
  });

  it("short window: sends only the token's spot totals (one row per account per day), no balance rows", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW, [
      { tokenId: BTC, amount: 1, usdValue: 100 },
      { tokenId: BTC, amount: 1, usdValue: 11, kind: "defi" },
      { tokenId: "token-eth", amount: 1, usdValue: 50 },
    ]);

    const raw = await call(USER, handleGetTokenValueHistory({ key: BTC, range: "30d" }));

    expect(raw.sampled).toBe(false);
    expect(raw.rows).toEqual([{ accountId: acc.id, takenAt: NOW, totalUsd: 100 }]);
  });

  it("long window (all): SQL caps rows per bucket; client min-max keeps extremes", async () => {
    const acc = await seedAccount(USER, "甲");
    // 400 daily snapshots would be 400 rows; the long window caps at 3 × 66 + 1 = 199 per account.
    for (let i = 0; i < 400; i++) {
      await seedSnapshot(USER, acc.id, NOW - i * DAY, [
        { tokenId: BTC, amount: 1, usdValue: 100 + (i % 7) * 10 },
      ]);
    }

    const raw = await call(USER, handleGetTokenValueHistory({ key: BTC, range: "all" }));

    expect(raw.sampled).toBe(true);
    expect(raw.rows.length).toBeGreaterThan(0);
    expect(raw.rows.length).toBeLessThanOrEqual(199);
    const series = tokenValueHistoryFromRaw(raw);
    expect(series.length).toBeLessThanOrEqual(82);
    expect(Math.min(...series.map((p) => p.total))).toBe(100);
    expect(Math.max(...series.map((p) => p.total))).toBe(160);
    // The last point is the latest snapshot (i = 0 → 100).
    expect(series.at(-1)).toEqual({ t: NOW, total: 100 });
  }, 120_000);

  it("empty key / negative since → schema rejects", () => {
    expect(TokenValueHistoryInput.safeParse({ key: "" }).success).toBe(false);
    expect(TokenValueHistoryInput.safeParse({ key: "t", since: -1 }).success).toBe(false);
  });
});
