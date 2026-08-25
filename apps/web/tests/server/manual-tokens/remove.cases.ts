import { beforeEach, describe, expect, it } from "vitest";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { handleRemoveManualToken, RemoveManualTokenInput } from "@/lib/server/manual-tokens/remove";
import { handleGetPortfolioOverview } from "@/lib/server/portfolio/overview";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 manual-tokens/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("manual-tokens/remove", () => {
  // #527 · removeManualToken
  const USER = "h-mtok-remove";

  const detail = (userId: string, accountId: string) =>
    call(userId, handleGetManualAccount({ accountId }));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("removeManualToken", () => {
    it("删掉一个币 → 明细里没了,它的活动一并消失", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });
      const before = await detail(USER, acc.id);

      await call(
        USER,
        handleRemoveManualToken({ accountId: acc.id, tokenId: before.tokens[0].id }),
      );

      const after = await detail(USER, acc.id);
      expect(after.tokens).toEqual([]);
      expect(after.activities).toEqual([]);
    });

    it("删完立刻取总览 → 总额已经不含它", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });
      const before = await detail(USER, acc.id);

      await call(
        USER,
        handleRemoveManualToken({ accountId: acc.id, tokenId: before.tokens[0].id }),
      );

      const overview = await call(USER, handleGetPortfolioOverview({}));
      expect(overview.holdings).toEqual([]);
    });

    it("tokenId 属于我的另一个账户 → 成功但什么都没删,那个账户不受影响", async () => {
      // **清单写的是「拒」,实测是「静默无操作」——** 而且这次现状是对的,理由值得记下来:
      // 两道归属校验都过了(账户是我的、token 也是我的,`tokens` 是 per-user 的),真正的删除是
      // `DELETE WHERE accountId = ? AND tokenId = ?` —— 那一对不匹配,于是删掉 0 行。
      // 没有越权、没有误删,所以「静默」不是漏洞;把它写成「拒」反而要多一次查询去证明这对不匹配。
      const a = await seedManualAccount(USER, "甲", { symbol: "BTC", unitPrice: 1, amount: 1 });
      const b = await seedManualAccount(USER, "乙", { symbol: "ETH", unitPrice: 1, amount: 1 });
      const bDetail = await detail(USER, b.id);

      await call(USER, handleRemoveManualToken({ accountId: a.id, tokenId: bDetail.tokens[0].id }));

      expect((await detail(USER, b.id)).tokens).toHaveLength(1);
      expect((await detail(USER, a.id)).tokens).toHaveLength(1);
    });

    it("别人的账户 → 拒,对方那个币还在", async () => {
      const theirs = await seedManualAccount(otherUser(USER), "他们的", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });
      const theirDetail = await detail(otherUser(USER), theirs.id);

      const exit = await callExit(
        USER,
        handleRemoveManualToken({ accountId: theirs.id, tokenId: theirDetail.tokens[0].id }),
      );

      expect(exit._tag).toBe("Failure");
      expect((await detail(otherUser(USER), theirs.id)).tokens).toHaveLength(1);
    });

    it("accountId / tokenId 空串 → schema 拒", () => {
      expect(RemoveManualTokenInput.safeParse({ accountId: "", tokenId: "t" }).success).toBe(false);
      expect(RemoveManualTokenInput.safeParse({ accountId: "a", tokenId: "" }).success).toBe(false);
    });
  });
});
