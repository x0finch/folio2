import { beforeEach, describe, expect, it } from "vitest";
import { handleCreateManualActivities } from "@/lib/server/manual-activities/create";
import {
  handleUpdateManualActivity,
  UpdateActivityInput,
} from "@/lib/server/manual-activities/update";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { HOUR, seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 manual-activities/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("manual-activities/update", () => {
  // #527 · updateManualActivity
  //
  // 与 create 一样:超支是**返回值**(`{ ok: false, reason: "overdraw" }`),不是失败。
  const USER = "h-mact-update";

  let T0 = 0;
  const at = (hours: number) => T0 + hours * HOUR;

  const detail = (userId: string, accountId: string) =>
    call(userId, handleGetManualAccount({ accountId }));

  const amountOf = async (userId: string, accountId: string, symbol: string) =>
    (await detail(userId, accountId)).tokens.find((t) => t.symbol === symbol)?.amount;

  /** 建一个有两笔活动的账本:开仓 10,之后 reduce 2 → 8。 */
  const seedLedger = async (userId: string) => {
    const acc = await seedManualAccount(userId, "手记", {
      symbol: "BTC",
      unitPrice: 100,
      amount: 10,
    });
    await call(
      userId,
      handleCreateManualActivities({
        accountId: acc.id,
        drafts: [
          {
            token: { symbol: "BTC", unitPrice: 100 },
            kind: "reduce",
            amount: 2,
            occurredAt: at(5),
          },
        ],
      }),
    );
    const acts = (await detail(userId, acc.id)).activities;
    return {
      acc,
      opening: acts.find((a) => a.amount === 10)!,
      reduce: acts.find((a) => a.amount === 2)!,
    };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    T0 = Date.now() + HOUR;
  });

  describe("updateManualActivity", () => {
    it("把数量改大 → 持仓跟着变", async () => {
      const { acc, opening } = await seedLedger(USER);

      const out = await call(
        USER,
        handleUpdateManualActivity({ activityId: opening.id, patch: { amount: 20 } }),
      );

      expect(out).toEqual({ ok: true });
      expect(await amountOf(USER, acc.id, "BTC")).toBe(18);
    });

    it("只改备注 → 数量、时间都不动", async () => {
      const { acc, reduce } = await seedLedger(USER);
      const before = await amountOf(USER, acc.id, "BTC");

      await call(
        USER,
        handleUpdateManualActivity({ activityId: reduce.id, patch: { memo: "手滑写错了" } }),
      );

      const after = (await detail(USER, acc.id)).activities.find((a) => a.id === reduce.id);
      expect(await amountOf(USER, acc.id, "BTC")).toBe(before);
      expect(after?.amount).toBe(2);
      expect(after?.occurredAt).toBe(reduce.occurredAt);
      expect(after?.memo).toBe("手滑写错了");
    });

    it("改 occurredAt → 那一笔在时间线上挪位置", async () => {
      const { acc, reduce } = await seedLedger(USER);

      await call(
        USER,
        handleUpdateManualActivity({ activityId: reduce.id, patch: { occurredAt: at(20) } }),
      );

      const acts = (await detail(USER, acc.id)).activities;
      expect(acts.at(-1)?.id).toBe(reduce.id);
    });

    it("把一笔 reduce 改成 set → 之后按 set 语义重算", async () => {
      const { acc, reduce } = await seedLedger(USER);

      await call(
        USER,
        handleUpdateManualActivity({ activityId: reduce.id, patch: { kind: "set", amount: 3 } }),
      );

      expect(await amountOf(USER, acc.id, "BTC")).toBe(3);
    });

    it("改完导致超支 → 拒,而且原值一个字没变", async () => {
      const { acc, reduce } = await seedLedger(USER);

      const out = await call(
        USER,
        handleUpdateManualActivity({ activityId: reduce.id, patch: { amount: 999 } }),
      );

      expect(out).toEqual({ ok: false, reason: "overdraw", symbol: "BTC" });
      expect(await amountOf(USER, acc.id, "BTC")).toBe(8);
      const still = (await detail(USER, acc.id)).activities.find((a) => a.id === reduce.id);
      expect(still?.amount).toBe(2);
    });

    it("patch 传空对象 → 什么都不改,不是把字段清空", async () => {
      const { acc, reduce } = await seedLedger(USER);

      await call(USER, handleUpdateManualActivity({ activityId: reduce.id, patch: {} }));

      const after = (await detail(USER, acc.id)).activities.find((a) => a.id === reduce.id);
      expect(after?.amount).toBe(2);
      expect(after?.kind).toBe(reduce.kind);
      expect(await amountOf(USER, acc.id, "BTC")).toBe(8);
    });

    it("改别人的活动 → 拒,对方账本不动", async () => {
      const theirs = await seedLedger(otherUser(USER));

      const exit = await callExit(
        USER,
        handleUpdateManualActivity({ activityId: theirs.reduce.id, patch: { amount: 1 } }),
      );

      expect(exit._tag).toBe("Failure");
      expect(await amountOf(otherUser(USER), theirs.acc.id, "BTC")).toBe(8);
    });

    it("activityId 不存在 → 拒", async () => {
      await seedLedger(USER);

      const exit = await callExit(
        USER,
        handleUpdateManualActivity({ activityId: "没有这个", patch: { amount: 1 } }),
      );

      expect(exit._tag).toBe("Failure");
    });

    it("amount 负数 / kind 不在枚举里 / activityId 空串 → schema 拒", () => {
      expect(
        UpdateActivityInput.safeParse({ activityId: "a", patch: { amount: -1 } }).success,
      ).toBe(false);
      expect(
        UpdateActivityInput.safeParse({ activityId: "a", patch: { kind: "swap" } }).success,
      ).toBe(false);
      expect(UpdateActivityInput.safeParse({ activityId: "", patch: {} }).success).toBe(false);
    });
  });
});
