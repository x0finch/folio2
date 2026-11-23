import { beforeEach, describe, expect, it } from "vitest";
import { handleGetTokenEnrichment } from "@/lib/server/tokens/enrichment";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, getSnapshotsDecoded } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

const HOUR = 3_600_000;

describe("portfolio/snapshots", () => {
  const USER = "h-pf-snapshots";
  const BTC = "token-btc";

  let NOW = 0;
  const ago = (ms: number) => NOW - ms;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  describe("getSnapshots", () => {
    it("historical read (with after): latest snapshot with takenAt ≤ at", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 50 }]);
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const at = ago(DAY + HOUR);
      const after = ago(3 * DAY);
      const rows = await call(USER, getSnapshotsDecoded({ at, after }));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accountId).toBe(acc.id);
      expect(rows[0]?.totalUsd).toBe(50);
    });

    it("current read (no after) = true latest, even if takenAt is slightly after at", async () => {
      // A just-synced snapshot's takenAt (server clock) can exceed the caller's `at` (wall clock);
      // cutting at `at` would show the account as never synced.
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW + HOUR, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const rows = await call(USER, getSnapshotsDecoded({ at: NOW }));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accountId).toBe(acc.id);
      expect(rows[0]?.totalUsd).toBe(100);
    });

    it("after lower bound: no snapshot in window → none returned", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(8 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const at = ago(DAY);
      const after = ago(7 * DAY);
      const rows = await call(USER, getSnapshotsDecoded({ at, after }));
      expect(rows).toEqual([]);
    });

    it("manual account holdings synthesized at `at`", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });

      const rows = await call(USER, getSnapshotsDecoded({ at: NOW }));
      const row = rows.find((r) => r.accountId === acc.id);
      expect(row?.balances.length).toBeGreaterThan(0);
      expect(row?.balances[0]?.amount).toBe(2);
    });

    it("portfolio-scoped: other portfolios' snapshots not returned", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const watch = await db(USER).portfolios.create({ name: "Watch" });
      const mine = await seedAccount(USER, "自己的", "bitcoin");
      const watched = await seedAccount(USER, "只看看", "binance");
      await db(USER).portfolios.assignAccount(mine.id, def.id);
      await db(USER).portfolios.assignAccount(watched.id, watch.id);
      await seedSnapshot(USER, mine.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, watched.id, NOW, [
        { tokenId: "token-eth", amount: 1, usdValue: 50 },
      ]);

      const rows = await call(USER, getSnapshotsDecoded({ portfolioId: watch.id, at: NOW }));
      expect(rows.map((r) => r.accountId)).toEqual([watched.id]);
    });
  });
});

describe("tokens/enrichment", () => {
  const USER = "h-tokens-enrich";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
  });

  describe("getTokenEnrichment", () => {
    it("returns all of the user's known tokens regardless of current snapshots", async () => {
      await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 100, amount: 1 });
      const first = await call(USER, handleGetTokenEnrichment());
      expect(first.enriched.length).toBeGreaterThan(0);

      await seedManualAccount(USER, "手记2", { symbol: "ETH", unitPrice: 50, amount: 2 });
      const second = await call(USER, handleGetTokenEnrichment());
      expect(second.enriched.length).toBeGreaterThan(first.enriched.length);
    });
  });
});
