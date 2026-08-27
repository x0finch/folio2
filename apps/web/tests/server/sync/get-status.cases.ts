import { beforeEach, describe, expect, it } from "vitest";
import { handleGetSyncStatus } from "@/lib/server/sync/get-status";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { callWithRegistry } from "../_kit/run";
import { DAY, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 sync/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("sync/get-status", () => {
  // #527 · getSyncStatus
  const USER = "h-sync-status";
  const BTC = "token-btc";

  let NOW = 0;
  // 摘要按选中的 Portfolio 收口(ADR 0033),所以要传一个;默认那个就是首屏选中的那个。
  const status = async (portfolioId?: string) => {
    const { registry } = await fakeRegistry();
    const pid = portfolioId ?? (await db(USER).portfolios.ensureDefault()).id;
    return callWithRegistry(USER, registry, handleGetSyncStatus({ portfolioId: pid }));
  };

  const cex = (userId: string, label: string, creds: Record<string, string> | null) =>
    db(userId).accounts.create({
      connectorId: "binance",
      label,
      creds: creds ? JSON.stringify(creds) : null,
    });

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  describe("getSyncStatus", () => {
    it("缺凭据、数旧了都进「需要注意」", async () => {
      const fresh = await cex(USER, "刚同步", { apiKey: "k", secret: "s" });
      await seedSnapshot(USER, fresh.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      const stale = await cex(USER, "很久没同步", { apiKey: "k", secret: "s" });
      await seedSnapshot(USER, stale.id, NOW - 30 * DAY, [
        { tokenId: BTC, amount: 1, usdValue: 100 },
      ]);
      await cex(USER, "缺凭据", { apiKey: "k" });

      const out = await status();

      // 一份清单装两件事(#527 裁定 8):缺凭据是「没有数」,30 天没同步是「有数但旧了」。
      // 排序按严重程度,缺凭据在前。
      expect(out.total).toBe(3);
      expect(out.attention.map((a) => [a.label, a.kind])).toEqual([
        ["缺凭据", "missing-credentials"],
        ["很久没同步", "stale"],
      ]);
      expect(out.lastSyncedAt).toBe(NOW);
    });

    it("从没同步过的账户 → 上次同步时刻是空,不是 1970", async () => {
      // 0 会被界面格式化成 1970-01-01,读起来像「同步过、只是很久以前」。
      await cex(USER, "没同步过", { apiKey: "k", secret: "s" });

      const out = await status();

      expect(out.lastSyncedAt).toBeNull();
      expect(out.attention.map((a) => a.kind)).toEqual(["never-synced"]);
    });

    it("另一个 Portfolio 里的账户不进这份摘要 —— 切组合它就该跟着变", async () => {
      // 修之前这里读的是该用户**全部**账户:切到只有一个账户的组合,页头仍然报着别处那 8 个,
      // 而下面的列表里一个都没有。
      const other = await db(USER).portfolios.create({ name: "Watch" });
      const mine = await cex(USER, "在默认里", { apiKey: "k", secret: "s" });
      const theirs = await cex(USER, "在 Watch 里", { apiKey: "k", secret: "s" });
      await db(USER).portfolios.assignAccount(theirs.id, other.id);

      const inDefault = await status();
      const inWatch = await status(other.id);

      expect(inDefault.accounts.map((a) => a.id)).toEqual([mine.id]);
      expect(inWatch.accounts.map((a) => a.id)).toEqual([theirs.id]);
      expect(inWatch.total).toBe(1);
    });

    it("别人的账户不进我的汇总", async () => {
      await cex(otherUser(USER), "他们的", { apiKey: "k", secret: "s" });

      expect((await status()).total).toBe(0);
    });
  });
});
