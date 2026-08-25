import { beforeEach, describe, expect, it } from "vitest";
import {
  GetManualAccountInput,
  handleGetManualAccount,
} from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { seedAccount, seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

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

  it("活动是账户级的一张平表(不挂在 token 下),按时间排好", async () => {
    // 形状值得记一笔:`{ tokens, activities }` 两张平表,活动经 tokenId 关联,而不是嵌在
    // 每个 token 里。前端据此自己归组;这里断言的是「排序已经做好了」。
    const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });

    const detail = await call(USER, handleGetManualAccount({ accountId: acc.id }));

    expect(detail.activities.length).toBeGreaterThan(0);
    const times = detail.activities.map((a) => a.occurredAt);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(new Set(detail.activities.map((a) => a.tokenId))).toEqual(
      new Set([detail.tokens[0].id]),
    );
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
