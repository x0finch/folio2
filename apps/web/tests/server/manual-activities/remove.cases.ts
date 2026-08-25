import { beforeEach, describe, expect, it } from "vitest";
import { handleCreateManualActivities } from "@/lib/server/manual-activities/create";
import {
  handleRemoveManualActivity,
  RemoveActivityInput,
} from "@/lib/server/manual-activities/remove";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { HOUR, seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 manual-activities/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("manual-activities/remove", () => {
  // #527 · removeManualActivity
  const USER = "h-mact-remove";

  let T0 = 0;
  const at = (hours: number) => T0 + hours * HOUR;

  const detail = (userId: string, accountId: string) =>
    call(userId, handleGetManualAccount({ accountId }));

  const amountOf = async (userId: string, accountId: string, symbol: string) =>
    (await detail(userId, accountId)).tokens.find((t) => t.symbol === symbol)?.amount;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    T0 = Date.now() + HOUR;
  });

  describe("removeManualActivity", () => {
    it("删掉一条 add → 持仓跟着变小", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });
      await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            { token: { symbol: "BTC", unitPrice: 1 }, kind: "add", amount: 5, occurredAt: at(5) },
          ],
        }),
      );
      expect(await amountOf(USER, acc.id, "BTC")).toBe(6);
      const added = (await detail(USER, acc.id)).activities.find((a) => a.amount === 5);

      await call(USER, handleRemoveManualActivity({ accountId: acc.id, activityId: added!.id }));

      expect(await amountOf(USER, acc.id, "BTC")).toBe(1);
    });

    it("活动 id 属于我的另一个账户 → 成功但删不掉它,那个账本不受影响", async () => {
      const a = await seedManualAccount(USER, "甲", { symbol: "BTC", unitPrice: 1, amount: 1 });
      const b = await seedManualAccount(USER, "乙", { symbol: "ETH", unitPrice: 1, amount: 1 });
      const bAct = (await detail(USER, b.id)).activities[0];

      // 与 `removeManualToken` 同一形状:归属校验只管「账户是我的」,真正的删除是
      // `DELETE WHERE id = ? AND accountId = ?` —— 那一对不匹配就删 0 行。没有越权,没有误删。
      await call(USER, handleRemoveManualActivity({ accountId: a.id, activityId: bAct.id }));

      expect((await detail(USER, b.id)).activities).toHaveLength(1);
      expect((await detail(USER, a.id)).activities).toHaveLength(1);
    });

    it("别人的活动 → 拒,对方账本不动", async () => {
      const theirs = await seedManualAccount(otherUser(USER), "他们的", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });
      const act = (await detail(otherUser(USER), theirs.id)).activities[0];

      const exit = await callExit(
        USER,
        handleRemoveManualActivity({ accountId: theirs.id, activityId: act.id }),
      );

      expect(exit._tag).toBe("Failure");
      expect((await detail(otherUser(USER), theirs.id)).activities).toHaveLength(1);
    });

    it("删一个已经删过的 → 静默幂等,与 deleteTag / deleteTabPin 同一规则", async () => {
      // 三个删除接口现在口径一致了:归属校验之后是裸 DELETE,删 0 行也算成功。
      // 这是仓库里删除语义的**统一事实**,值得有一条各自钉住 —— 否则将来只改其中一个,
      // 界面上就会出现「这个删两次报错、那个不报」。
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });
      const act = (await detail(USER, acc.id)).activities[0];

      await call(USER, handleRemoveManualActivity({ accountId: acc.id, activityId: act.id }));
      await call(USER, handleRemoveManualActivity({ accountId: acc.id, activityId: act.id }));

      expect((await detail(USER, acc.id)).activities).toEqual([]);
    });

    it("accountId / activityId 空串 → schema 拒", () => {
      expect(RemoveActivityInput.safeParse({ accountId: "", activityId: "x" }).success).toBe(false);
      expect(RemoveActivityInput.safeParse({ accountId: "a", activityId: "" }).success).toBe(false);
    });
  });
});
