import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { PortfolioScopeInput } from "@/lib/server/portfolio/scope";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readOverview, readSnapshotData } from "../_kit/run";
import { seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// `readOverview` = atomic reads + `overviewFromSnapshotData` (the frontend `select`), no duplicated logic.
describe("portfolio/overview", () => {
  const USER = "h-pf-overview";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let NOW = 0;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("overview (snapshot data + client compute)", () => {
    it("three accounts holding one token → one row, value summed", async () => {
      for (const [label, value] of [
        ["甲", 100],
        ["乙", 200],
        ["丙", 300],
      ] as const) {
        const acc = await seedAccount(USER, label, "bitcoin");
        await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: value }]);
      }

      const view = await readOverview(USER, {});

      expect(view.holdings).toHaveLength(1);
      expect(view.holdings[0].totalValue).toBe(600);
      expect(view.totalUsd).toBe(600);
    });

    it("two tokens → two independent rows", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW, [
        { tokenId: BTC, amount: 1, usdValue: 100 },
        { tokenId: ETH, amount: 2, usdValue: 50 },
      ]);

      const view = await readOverview(USER, {});

      expect(view.holdings).toHaveLength(2);
      expect(view.totalUsd).toBe(150);
    });

    it("manual and on-chain account hold one token → one row, two sources", async () => {
      // Merging is by tokenId, not symbol: create the manual account first (mints the token row),
      // then seed the on-chain snapshot with that id.
      const manual = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50,
        amount: 2,
      });
      const detail = await call(USER, handleGetManualAccount({ accountId: manual.id }));
      const mintedBtc = detail.tokens[0].id;

      const chain = await seedAccount(USER, "链上", "bitcoin");
      await seedSnapshot(USER, chain.id, NOW, [{ tokenId: mintedBtc, amount: 1, usdValue: 100 }]);

      const view = await readOverview(USER, {});

      const btcRow = view.holdings.find((h) => (h.totalAmount ?? 0) >= 3);
      expect(btcRow).toBeDefined();
      expect(btcRow?.sources.length).toBeGreaterThanOrEqual(2);
    });

    it("perp underwater → total is negative, not clamped to 0", async () => {
      const acc = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, acc.id, NOW, [
        { tokenId: "token-perp", amount: 1, usdValue: -500, kind: "perp_equity" },
      ]);

      const view = await readOverview(USER, {});

      expect(view.totalUsd).toBe(-500);
    });

    it("someone else's portfolioId → silently default view, none of their data", async () => {
      const theirPf = await db(otherUser(USER)).portfolios.ensureDefault();
      const theirAcc = await seedAccount(otherUser(USER), "他们的", "bitcoin");
      await seedSnapshot(otherUser(USER), theirAcc.id, NOW, [
        { tokenId: BTC, amount: 1, usdValue: 999 },
      ]);
      const mine = await seedAccount(USER, "我的", "bitcoin");
      await seedSnapshot(USER, mine.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const view = await readOverview(USER, { portfolioId: theirPf.id });

      expect(view.totalUsd).toBe(100);
    });

    it("new user → empty but well-formed view, not an error", async () => {
      const view = await readOverview(USER, {});

      expect(view.holdings).toEqual([]);
      expect(view.sections).toEqual([]);
      expect(view.totalUsd).toBe(0);
      expect(view.accountTotals).toEqual([]);
    });

    it("never-synced account → in accountTotals with null takenAt", async () => {
      await seedAccount(USER, "没同步过", "bitcoin");

      const view = await readOverview(USER, {});

      expect(view.accountTotals).toHaveLength(1);
      expect(view.accountTotals[0].takenAt).toBeNull();
    });
  });

  describe("snapshot data (atomic assembly)", () => {
    it("raw data only: rows plus lookups, no aggregation", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const raw = await readSnapshotData(USER, {});

      expect(raw.accounts.map((a) => a.label)).toEqual(["甲"]);
      expect(raw.snapshots).toHaveLength(1);
      const [[accId, snap]] = raw.snapshots;
      expect(accId).toBe(acc.id);
      expect(snap.balances.map((b) => b.tokenId)).toEqual([BTC]);
      expect(snap.balances[0].usdValue).toBe(100);
      // Lookups and settings only; no aggregate fields (total / holdings / subtotals).
      expect(raw.mode).toBe("self-first");
      expect(raw).not.toHaveProperty("totalUsd");
      expect(raw).not.toHaveProperty("holdings");
      expect(raw).not.toHaveProperty("holdingsSubtotal");
      expect(raw).not.toHaveProperty("pricesStale");
    });

    it("scope filters the raw data: a connector pin sends only that connector's accounts", async () => {
      const btcAcc = await seedAccount(USER, "链上", "bitcoin");
      await seedSnapshot(USER, btcAcc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      const cexAcc = await seedAccount(USER, "交易所", "binance");
      await seedSnapshot(USER, cexAcc.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 900 }]);

      const scope = { pin: { kind: "connector", connectorId: "bitcoin" } } as const;
      const raw = await readSnapshotData(USER, scope);

      expect(raw.accounts.map((a) => a.label)).toEqual(["链上"]);
      expect(raw.snapshots.map(([id]) => id)).toEqual([btcAcc.id]);
      expect((await readOverview(USER, scope)).totalUsd).toBe(100);
    });
  });

  describe("input schema", () => {
    it("missing input → schema defaults, loader can call without args", () => {
      expect(PortfolioScopeInput.parse(undefined)).toEqual({});
    });

    it("unknown pin kind → schema rejects", () => {
      expect(PortfolioScopeInput.safeParse({ pin: { kind: "portfolio" } }).success).toBe(false);
    });
  });
});
