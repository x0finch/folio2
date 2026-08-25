import { beforeEach, describe, expect, it } from "vitest";
import {
  CreateActivitiesInput,
  handleCreateManualActivities,
} from "@/lib/server/manual-activities/create";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { HOUR, seedManualAccount } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// 合并进 manual-activities/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("manual-activities/create", () => {
  // #527 · createManualActivities
  //
  // **超支不是失败,是返回值**:`{ ok: false, reason: "overdraw", symbol }`。这一点决定了对抗那几条
  // 该怎么断言 —— 用 `call` 拿返回值,不是用 `callExit` 看有没有炸。
  const USER = "h-mact-create";

  // **时间基准取自真实时钟,而且必须晚于开仓那一笔。**
  //
  // 实测撞过一次:一开始我用了一个写死的过去时刻(2026-02),而 `seedManualAccount` 落的开仓活动
  // 用的是 `Date.now()`(2026-08)—— 于是「开仓」排在我所有草稿之后,持有量被它按回 0,四条用例
  // 一起红。这一片测的是**顺序**,所以基准只能相对开仓来取,不能写死。
  let T0 = 0;
  const at = (hours: number) => T0 + hours * HOUR;

  const draft = (
    symbol: string,
    kind: "add" | "reduce" | "set",
    amount: number,
    occurredAt: number,
  ) => ({ token: { symbol, unitPrice: 1 }, kind, amount, occurredAt });

  const detail = (accountId: string) => call(USER, handleGetManualAccount({ accountId }));

  /** 某个 symbol 现在的持有量。 */
  const amountOf = async (accountId: string, symbol: string) => {
    const d = await detail(accountId);
    return d.tokens.find((t) => t.symbol === symbol)?.amount;
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    T0 = Date.now() + HOUR; // 稳稳晚于开仓那一笔
  });

  describe("createManualActivities", () => {
    it("一次提交三条 → 三条都在,持仓按它们算出来", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 10,
      });

      const out = await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            draft("BTC", "add", 1, at(7)),
            draft("BTC", "add", 2, at(8)),
            draft("BTC", "reduce", 3, at(9)),
          ],
        }),
      );

      expect(out).toEqual({ ok: true });
      expect(await amountOf(acc.id, "BTC")).toBe(10);
      expect((await detail(acc.id)).activities.length).toBe(4); // 开仓那笔 + 三条
    });

    it("提交的币这个账户已有声明 → 收养它,不新建重复的 token", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });

      await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [draft("BTC", "add", 5, at(10))],
        }),
      );

      const d = await detail(acc.id);
      expect(d.tokens.filter((t) => t.symbol === "BTC")).toHaveLength(1);
      expect(d.tokens[0].amount).toBe(6);
    });

    it("一笔 set(校准)→ 持有量直接变成那个数,不管之前是多少", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 7 });

      await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [draft("BTC", "set", 2, at(10))],
        }),
      );

      expect(await amountOf(acc.id, "BTC")).toBe(2);
    });

    it("先 add 后 set 再 reduce → 按顺序算,reduce 扣的是 set 之后的量", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });

      const out = await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            draft("BTC", "add", 100, at(7)),
            draft("BTC", "set", 5, at(8)),
            draft("BTC", "reduce", 4, at(9)),
          ],
        }),
      );

      expect(out).toEqual({ ok: true });
      expect(await amountOf(acc.id, "BTC")).toBe(1);
    });

    it("三条里第二条超支 → 三条都不落,库里干干净净(原子)", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });
      const before = (await detail(acc.id)).activities.length;

      const out = await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            draft("BTC", "add", 1, at(7)),
            draft("BTC", "reduce", 999, at(8)),
            draft("BTC", "add", 1, at(9)),
          ],
        }),
      );

      expect(out).toEqual({ ok: false, reason: "overdraw", symbol: "BTC" });
      expect((await detail(acc.id)).activities.length).toBe(before);
      expect(await amountOf(acc.id, "BTC")).toBe(1);
    });

    it("reduce 超过持有量 → 说清是哪个币,不是落成负数", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 2 });

      const out = await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [draft("BTC", "reduce", 5, at(10))],
        }),
      );

      expect(out).toEqual({ ok: false, reason: "overdraw", symbol: "BTC" });
      expect(await amountOf(acc.id, "BTC")).toBe(2);
    });

    it("同一批提交两次(手抖双击)→ 活动条数翻倍,不是被去重", async () => {
      // **钉现状,而这个现状是个待定项(#527)。** 没有幂等键,所以双击就是两批。手记账本里
      // 「同一天买了两次一样的量」确实可能是真的,所以去重不一定对 —— 但界面上没有任何东西
      // 告诉用户刚才那一下成功了没有。要不要加幂等键是你的决定。
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 0 });
      const body = { accountId: acc.id, drafts: [draft("BTC", "add", 1, at(10))] };

      await call(USER, handleCreateManualActivities(body));
      await call(USER, handleCreateManualActivities(body));

      expect(await amountOf(acc.id, "BTC")).toBe(2);
    });

    it("occurredAt 是未来时间 → schema 拒(#527 裁定 6)", () => {
      // 曲线按活动累积,一条未来的买入会让右端翘起一块还没发生的资产 —— 而它看起来和真的一样。
      // 客户端时钟快几秒仍照收(留了缓冲),那半在 tests/occurred-at.test.ts。
      const future = { ...draft("BTC", "add", 1, 0), occurredAt: Date.now() + 24 * 3600_000 };

      expect(CreateActivitiesInput.safeParse({ accountId: "a", drafts: [future] }).success).toBe(
        false,
      );
    });

    it("drafts 是空数组 / amount 是负数 / symbol 空串 → schema 拒", () => {
      expect(CreateActivitiesInput.safeParse({ accountId: "a", drafts: [] }).success).toBe(false);
      expect(
        CreateActivitiesInput.safeParse({
          accountId: "a",
          drafts: [
            { token: { symbol: "BTC", unitPrice: 1 }, kind: "add", amount: -1, occurredAt: 0 },
          ],
        }).success,
      ).toBe(false);
      expect(
        CreateActivitiesInput.safeParse({
          accountId: "a",
          drafts: [{ token: { symbol: "", unitPrice: 1 }, kind: "add", amount: 1, occurredAt: 0 }],
        }).success,
      ).toBe(false);
    });
  });
});
