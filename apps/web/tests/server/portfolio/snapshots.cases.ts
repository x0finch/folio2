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
    it("历史读(带 after)at 上界:只取 takenAt ≤ at 的最近一张", async () => {
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

    it("当下读(无 after)= 真最新:takenAt 略晚于 at 也回 —— 同步刚写不被截掉", async () => {
      // 回归:同步刚落库的快照 takenAt(服务端时钟)可能略超读取方传入的 at(墙钟)。
      // 当下读若按 at 截,会把刚同步的账户显示成「从未同步」(e2e sync-round)。
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW + HOUR, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const rows = await call(USER, getSnapshotsDecoded({ at: NOW }));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accountId).toBe(acc.id);
      expect(rows[0]?.totalUsd).toBe(100);
    });

    it("after 下界:窗口内无快照 → 不回", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(8 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const at = ago(DAY);
      const after = ago(7 * DAY);
      const rows = await call(USER, getSnapshotsDecoded({ at, after }));
      expect(rows).toEqual([]);
    });

    it("manual 账户在 at 合成持仓", async () => {
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

    it("按组合收口:别的组合账户的快照不回", async () => {
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
    it("回用户全部已知代币,与当前快照无关", async () => {
      await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 100, amount: 1 });
      const first = await call(USER, handleGetTokenEnrichment());
      expect(first.enriched.length).toBeGreaterThan(0);

      await seedManualAccount(USER, "手记2", { symbol: "ETH", unitPrice: 50, amount: 2 });
      const second = await call(USER, handleGetTokenEnrichment());
      expect(second.enriched.length).toBeGreaterThan(first.enriched.length);
    });
  });
});
