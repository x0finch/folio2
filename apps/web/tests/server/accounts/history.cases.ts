import { beforeEach, describe, expect, it } from "vitest";
import { buildAccountValueHistory } from "@/lib/core/history";
import { AccountHistoryInput, handleGetAccountHistory } from "@/lib/server/accounts/history";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("accounts/history", () => {
  // The endpoint returns raw points; windowing and downsampling happen client-side, so `curve()`
  // replays the drawer's two steps.
  const USER = "h-acc-history";
  const BTC = "token-btc";

  let NOW = 0;
  const ago = (ms: number) => NOW - ms;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  const curve = async (input: { accountId: string; since?: number; connectorId?: string }) => {
    const raw = await call(USER, handleGetAccountHistory(input));
    return buildAccountValueHistory(raw.rows, raw.live, { sampled: raw.sampled });
  };

  describe("getAccountHistory", () => {
    it("manual account → curve from the ledger, last point at current price", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });

      const series = await curve({ accountId: acc.id, connectorId: "manual" });

      expect(series.length).toBeGreaterThan(0);
      // The last point is the live mark-to-market "now", not an old snapshot's time.
      expect(Date.now() - (series.at(-1)?.t ?? 0)).toBeLessThan(60_000);
    });

    it("never synced → empty curve, no error", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");

      expect(await curve({ accountId: acc.id })).toEqual([]);
    });

    it("negative points (perp underwater) → returned as-is, curve crosses 0", async () => {
      const acc = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, acc.id, ago(2 * DAY), [
        { tokenId: BTC, amount: 1, usdValue: 100, kind: "perp_equity" },
      ]);
      await seedSnapshot(USER, acc.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: -50, kind: "perp_equity" },
      ]);

      const series = await curve({ accountId: acc.id });

      expect(series.map((p) => p.total)).toEqual([100, -50]);
    });

    it("window start in the future → empty curve, not an error", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      expect(await curve({ accountId: acc.id, since: NOW + 30 * DAY })).toEqual([]);
    });

    // The window is the response's upper bound: points aren't downsampled server-side, so without
    // `since` a year-old account would ship its whole history.
    it("only raw points inside the window are sent", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(40 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 120 }]);

      const all = await call(USER, handleGetAccountHistory({ accountId: acc.id }));
      const month = await call(
        USER,
        handleGetAccountHistory({ accountId: acc.id, since: NOW - 30 * DAY, range: "30d" }),
      );

      expect(Object.keys(all).sort()).toEqual(["live", "rows", "sampled"]);
      expect(all.sampled).toBe(true);
      expect(all.rows).toHaveLength(2); // two points: min-max path returns them as-is
      expect(month.rows).toHaveLength(1); // the 40-day-old row is not sent
      expect(month.rows[0]?.totalUsd).toBe(120);
    });

    // Manual grids must be computed from the first activity; the window only limits what's sent.
    it("manual account: full grid computed, only the window sent", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });

      const all = await call(
        USER,
        handleGetAccountHistory({ accountId: acc.id, connectorId: "manual" }),
      );
      const future = await call(
        USER,
        handleGetAccountHistory({
          accountId: acc.id,
          since: NOW + 30 * DAY,
          connectorId: "manual",
        }),
      );

      expect(all.rows.length).toBeGreaterThan(0);
      expect(future.rows).toEqual([]);
    });

    it("someone else's account → rejected", async () => {
      const theirs = await seedAccount(otherUser(USER), "他们的", "bitcoin");
      await seedSnapshot(otherUser(USER), theirs.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: 999 },
      ]);

      const exit = await callExit(USER, handleGetAccountHistory({ accountId: theirs.id }));

      expect(exit._tag).toBe("Failure");
    });

    it("empty accountId / negative since → schema rejects", () => {
      expect(AccountHistoryInput.safeParse({ accountId: "" }).success).toBe(false);
      expect(AccountHistoryInput.safeParse({ accountId: "a", since: -1 }).success).toBe(false);
      expect(AccountHistoryInput.safeParse({ accountId: "a" }).success).toBe(true);
    });
  });
});
