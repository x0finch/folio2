import { beforeEach, describe, expect, it } from "vitest";
import {
  accountRowsFromRaw,
  assembleAccountHoldingsData,
  floorToHour,
  GAIN_START_FLOOR_MS,
  GAIN_WINDOW_MS,
} from "@/lib/core/portfolio";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { handleListAccountHoldings } from "@/lib/server/portfolio/account-holdings";
import { handleGetSnapshots } from "@/lib/server/portfolio/snapshots";
import { handleGetValuationSettings } from "@/lib/server/settings/valuation";
import { handleGetTokenEnrichment } from "@/lib/server/tokens/enrichment";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
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
    it("at 上界:只取 takenAt ≤ at 的最近一张", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 50 }]);
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const at = ago(DAY + HOUR);
      const rows = await call(USER, handleGetSnapshots({ at, now: at }));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accountId).toBe(acc.id);
      expect(rows[0]?.totalUsd).toBe(50);
    });

    it("after 下界:窗口内无快照 → 不回", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(8 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const at = ago(DAY);
      const after = ago(7 * DAY);
      const rows = await call(USER, handleGetSnapshots({ at, after, now: NOW }));
      expect(rows).toEqual([]);
    });

    it("manual 账户在 at 合成持仓", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });

      const at = floorToHour(NOW);
      const rows = await call(USER, handleGetSnapshots({ at, now: NOW }));
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

      const rows = await call(
        USER,
        handleGetSnapshots({ portfolioId: watch.id, at: NOW, now: NOW }),
      );
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

describe("portfolio/account-holdings-compose", () => {
  const USER = "h-pf-compose";
  const BTC = "token-btc";

  let NOW = 0;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    NOW = Date.now();
  });

  it("原子资源合并后与 listAccountHoldings 逐值一致", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    const now = floorToHour(NOW);
    await seedSnapshot(USER, acc.id, now - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, now, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
    const [snapshotsNow, snapshotsPrev, settings, enrichment, accounts, fat] = await Promise.all([
      call(USER, handleGetSnapshots({ at: now, now: NOW })),
      call(
        USER,
        handleGetSnapshots({ at: now - GAIN_WINDOW_MS, after: now - GAIN_START_FLOOR_MS, now }),
      ),
      call(USER, handleGetValuationSettings()),
      call(USER, handleGetTokenEnrichment()),
      call(USER, handleListAccounts({})),
      call(USER, handleListAccountHoldings({})),
    ]);

    const composed = accountRowsFromRaw(
      assembleAccountHoldingsData({
        accounts: accounts.map((a) => ({ id: a.id, label: a.label, archivedAt: a.archivedAt })),
        snapshotsNow,
        snapshotsPrev,
        mode: settings.valuationMode,
        enriched: new Map(enrichment.enriched),
      }),
    );
    const legacy = accountRowsFromRaw(fat);
    expect(composed.rows[0]?.totalUsd).toBeCloseTo(legacy.rows[0]?.totalUsd ?? 0, 6);
    expect(composed.rows[0]?.gain24h?.amount).toBeCloseTo(legacy.rows[0]?.gain24h?.amount ?? 0, 6);
    expect(composed.pricesStale).toBe(legacy.pricesStale);
  });
});
