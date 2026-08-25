import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountHoldings } from "@/lib/server/portfolio/account-holdings";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolio/account-holdings", () => {
  // #527 · listAccountHoldings
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

  describe("listAccountHoldings", () => {
    it("三个账户 → 三行,每行的市值等于它自己那些余额之和", async () => {
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

      const view = await call(USER, handleListAccountHoldings());

      expect(view.rows).toHaveLength(3);
      for (const row of view.rows) {
        const sum = row.balances.reduce((s, x) => s + x.usdValue, 0);
        expect(row.totalUsd).toBeCloseTo(sum, 6);
      }
    });

    it("手记账户 → 有行、有持仓,来自账本合成", async () => {
      await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 100, amount: 3 });

      const view = await call(USER, handleListAccountHoldings());

      expect(view.rows).toHaveLength(1);
      expect(view.rows[0].balances.length).toBeGreaterThan(0);
      expect(view.rows[0].balances[0].amount).toBe(3);
    });

    it("归档账户 → 在列表里但标着归档,值停在封存那一刻", async () => {
      const acc = await seedAccount(USER, "归档", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 777 }]);
      await db(USER).accounts.setArchived(acc.id, true);

      const view = await call(USER, handleListAccountHoldings());

      const row = view.rows.find((r) => r.account.id === acc.id);
      expect(row).toBeDefined();
      expect(row?.archivedAt).not.toBeNull();
      expect(row?.totalUsd).toBe(777);
    });

    it("从没同步过的账户 → 出现在列表里,余额是空的", async () => {
      const acc = await seedAccount(USER, "没同步过", "bitcoin");

      const view = await call(USER, handleListAccountHoldings());

      const row = view.rows.find((r) => r.account.id === acc.id);
      expect(row).toBeDefined();
      expect(row?.balances).toEqual([]);
    });

    it("全新用户 → 空列表,不是报错", async () => {
      const view = await call(USER, handleListAccountHoldings());

      expect(view.rows).toEqual([]);
    });

    it("不带 withGain → 每行都没有盈亏字段(那一趟不读窗口历史)", async () => {
      // 这是 #488 票 5 的切法:总览不再读窗口历史,盈亏由独立那一趟带回来。
      // 断言「不带就没有」比断言「带了就有」稳 —— 后者还取决于基准点取不取到,
      // 而那件事已经由 `gain.test.ts` 专门覆盖了。
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

      const without = await call(USER, handleListAccountHoldings());

      expect(without.rows[0].gain24h).toBeUndefined();
      for (const b of without.rows[0].balances) expect(b.gain24h).toBeUndefined();
    });
  });
});
