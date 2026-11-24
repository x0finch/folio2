import { beforeEach, describe, expect, it } from "vitest";
import { floorToHour } from "@/lib/core/portfolio";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { readAccountHoldingsView } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("portfolio/account-holdings", () => {
  const USER = "h-pf-acc-holdings";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let NOW = 0;
  const ago = (ms: number) => NOW - ms;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  describe("per-account holdings (atomic merge)", () => {
    it("three accounts → three rows, each valued at its own balances' sum", async () => {
      for (const [label, a, b] of [
        ["甲", 100, 20],
        ["乙", 200, 30],
        ["丙", 300, 40],
      ] as const) {
        const acc = await seedAccount(USER, label, "bitcoin");
        await seedSnapshot(USER, acc.id, NOW, [
          { tokenId: BTC, amount: 1, usdValue: a },
          { tokenId: ETH, amount: 1, usdValue: b },
        ]);
      }

      const view = await readAccountHoldingsView(USER);

      expect(view.rows).toHaveLength(3);
      for (const row of view.rows) {
        const sum = row.balances.reduce((s, x) => s + x.usdValue, 0);
        expect(row.totalUsd).toBeCloseTo(sum, 6);
      }
    });

    it("manual account → row with holdings synthesized from the ledger", async () => {
      await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 100, amount: 3 });

      const view = await readAccountHoldingsView(USER);

      expect(view.rows).toHaveLength(1);
      expect(view.rows[0].balances.length).toBeGreaterThan(0);
      expect(view.rows[0].balances[0].amount).toBe(3);
    });

    it("archived account → listed as archived, value frozen at the seal", async () => {
      const acc = await seedAccount(USER, "归档", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 777 }]);
      await db(USER).accounts.setArchived(acc.id, true);

      const view = await readAccountHoldingsView(USER);

      const row = view.rows.find((r) => r.account.id === acc.id);
      expect(row).toBeDefined();
      expect(row?.archivedAt).not.toBeNull();
      expect(row?.totalUsd).toBe(777);
    });

    it("never-synced account → listed with empty balances", async () => {
      const acc = await seedAccount(USER, "没同步过", "bitcoin");

      const view = await readAccountHoldingsView(USER);

      const row = view.rows.find((r) => r.account.id === acc.id);
      expect(row).toBeDefined();
      expect(row?.balances).toEqual([]);
    });

    it("new user → empty list, not an error", async () => {
      const view = await readAccountHoldingsView(USER);

      expect(view.rows).toEqual([]);
    });

    it("24h P&L comes with holdings: now minus 24h ago", async () => {
      // Baseline is the latest snapshot at or before 24h ago: 100 → 130 is +30 / +30% at both levels.
      const now = floorToHour(NOW);
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, now - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, now, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

      const view = await readAccountHoldingsView(USER);
      const row = view.rows.find((r) => r.account.id === acc.id);
      expect(row?.gain24h?.amount).toBeCloseTo(30, 6);
      expect(row?.gain24h?.pct).toBeCloseTo(30, 6);
      const btc = row?.balances.find((b) => b.tokenId === BTC);
      expect(btc?.gain24h?.amount).toBeCloseTo(30, 6);
    });

    it("new account (no 24h baseline) → P&L null, not forced", async () => {
      const acc = await seedAccount(USER, "新号", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

      const view = await readAccountHoldingsView(USER);
      const row = view.rows.find((r) => r.account.id === acc.id);
      expect(row?.gain24h).toBeNull();
      expect(row?.balances.find((b) => b.tokenId === BTC)?.gain24h).toBeNull();
    });

    it("offline > 7 days (no baseline in window) → P&L null, not inflated", async () => {
      const acc = await seedAccount(USER, "断线", "bitcoin");
      // The only snapshot is 8 days old (outside the 7-day window) → no baseline.
      await seedSnapshot(USER, acc.id, ago(8 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

      const view = await readAccountHoldingsView(USER);
      const row = view.rows.find((r) => r.account.id === acc.id);
      expect(row?.gain24h).toBeNull();
    });

    it("archived account → P&L field omitted (undefined)", async () => {
      const now = floorToHour(NOW);
      const acc = await seedAccount(USER, "归档", "bitcoin");
      await seedSnapshot(USER, acc.id, now - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, now, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
      await db(USER).accounts.setArchived(acc.id, true);

      const view = await readAccountHoldingsView(USER);
      const row = view.rows.find((r) => r.account.id === acc.id);
      expect(row?.gain24h).toBeUndefined();
    });
  });
});
