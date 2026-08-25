import { beforeEach, describe, expect, it } from "vitest";
import {
  GetManualAccountInput,
  handleGetManualAccount,
} from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { seedAccount, seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 manual-tokens/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("manual-tokens/get-account", () => {
  // #527 · getManualAccount
  const USER = "h-mtok-detail";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("getManualAccount", () => {
    it("一个币 → 明细里有它,持有量来自账本那一笔开仓", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });

      const detail = await call(USER, handleGetManualAccount({ accountId: acc.id }));

      expect(detail.tokens).toHaveLength(1);
      expect(detail.tokens[0].symbol).toBe("BTC");
      expect(detail.tokens[0].amount).toBe(2);
    });

    it("非手记账户的 id 传进来 → 明细是空的,不是一个假装有内容的壳", async () => {
      const acc = await seedAccount(USER, "链上", "bitcoin");

      const detail = await call(USER, handleGetManualAccount({ accountId: acc.id }));

      expect(detail.tokens).toEqual([]);
      expect(detail.activities).toEqual([]);
    });

    it("别人的 accountId → 拒", async () => {
      const theirs = await seedManualAccount(otherUser(USER), "他们的", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });

      const exit = await callExit(USER, handleGetManualAccount({ accountId: theirs.id }));

      expect(exit._tag).toBe("Failure");
    });

    it("accountId 空串 → schema 拒", () => {
      expect(GetManualAccountInput.safeParse({ accountId: "" }).success).toBe(false);
    });
  });
});
