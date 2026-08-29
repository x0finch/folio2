import { beforeEach, describe, expect, it } from "vitest";
import { buildAccountValueHistory } from "@/lib/core/history";
import { AccountHistoryInput, handleGetAccountHistory } from "@/lib/server/accounts/history";
import { handleUpdateAccount } from "@/lib/server/accounts/update";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 accounts/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("accounts/history", () => {
  // #527 · getAccountHistory
  //
  // **FOL-38 之后这条接口只发原料**(ADR 0049):快照点 +(手记账户的)当下点,裁窗口与降采样
  // 都在浏览器里。所以要看曲线的用例走 `curve()` —— 把抽屉里那两行照抄一遍,断言的仍然是
  // 屏幕上那条线。
  const USER = "h-acc-history";
  const BTC = "token-btc";

  let NOW = 0;
  const ago = (ms: number) => NOW - ms;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  /** 抽屉里那两行:接口给原料,浏览器裁窗口 + 降采样。 */
  const curve = async (input: { accountId: string; connectorId?: string }, since?: number) => {
    const raw = await call(USER, handleGetAccountHistory(input));
    return buildAccountValueHistory(raw.rows, since, raw.live);
  };

  describe("getAccountHistory", () => {
    it("手记账户 → 曲线由账本算出,末点是按当前价的实时值", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });

      const series = await curve({ accountId: acc.id, connectorId: "manual" });

      expect(series.length).toBeGreaterThan(0);
      expect(series.at(-1)?.t).toBeGreaterThanOrEqual(ago(DAY));
    });

    it("已归档的手记账户 → 末点停在封存时刻,不补实时点", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });
      await call(USER, handleUpdateAccount({ accountId: acc.id, archived: true }));
      const archivedAt = (await db(USER).accounts.getById(acc.id))?.archivedAt ?? 0;

      const raw = await call(
        USER,
        handleGetAccountHistory({ accountId: acc.id, connectorId: "manual" }),
      );

      // 「当下」那一笔正是「还在动」的那一笔(ADR 0039)—— 封存之后接口连它都不发。
      expect(raw.live).toBeNull();
      const series = buildAccountValueHistory(raw.rows, undefined, raw.live);
      expect(series.at(-1)?.t).toBeLessThanOrEqual(archivedAt);
    });

    it("从没同步过 → 空曲线,不报错", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");

      expect(await curve({ accountId: acc.id })).toEqual([]);
    });

    it("历史里有负值点(perp 亏穿)→ 原样返回,曲线跨 0 不失真", async () => {
      const acc = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, acc.id, ago(2 * DAY), [
        { tokenId: BTC, amount: 1, usdValue: 100, kind: "perp_equity" },
      ]);
      await seedSnapshot(USER, acc.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: -50, kind: "perp_equity" },
      ]);

      const series = await curve({ accountId: acc.id });

      expect(series.map((p) => p.total)).toEqual([100, -50]);
    });

    it("窗口起点在未来 → 空曲线,不是报错", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      expect(await curve({ accountId: acc.id }, NOW + 30 * DAY)).toEqual([]);
    });

    // FOL-38 验收 ① —— 响应里只有原料点。换时间窗因此不再回服务器:同一份原料裁两次。
    it("接口只发原料点,一份原料喂得动任何一个时间窗", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(40 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 120 }]);

      const raw = await call(USER, handleGetAccountHistory({ accountId: acc.id }));

      expect(Object.keys(raw).sort()).toEqual(["live", "rows"]);
      expect(raw.rows).toHaveLength(2); // 两次同步两行,没有被降采样合并
      expect(buildAccountValueHistory(raw.rows, undefined, raw.live)).toHaveLength(2); // 全部
      expect(buildAccountValueHistory(raw.rows, NOW - 30 * DAY, raw.live)).toHaveLength(1); // 30 天
    });

    it("别人的账户 → 拒", async () => {
      const theirs = await seedAccount(otherUser(USER), "他们的", "bitcoin");
      await seedSnapshot(otherUser(USER), theirs.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: 999 },
      ]);

      const exit = await callExit(USER, handleGetAccountHistory({ accountId: theirs.id }));

      expect(exit._tag).toBe("Failure");
    });

    it("accountId 空串 → schema 拒", () => {
      expect(AccountHistoryInput.safeParse({ accountId: "" }).success).toBe(false);
      expect(AccountHistoryInput.safeParse({ accountId: "a" }).success).toBe(true);
    });
  });
});
