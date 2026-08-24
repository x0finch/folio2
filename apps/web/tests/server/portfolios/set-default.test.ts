import { NotFound } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import {
  handleSetDefaultPortfolio,
  SetDefaultPortfolioInput,
} from "@/lib/server/portfolios/set-default";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// #527 · setDefaultPortfolio
const USER = "h-pfs-default";

const defaults = async (userId: string) => {
  const out = await call(userId, handleListPortfolios());
  return { id: out.defaultId, count: out.portfolios.filter((p) => p.isDefault).length };
};

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("setDefaultPortfolio", () => {
  it("设 B 为默认 → B 是默认,A 不再是", async () => {
    const a = await db(USER).portfolios.ensureDefault();
    const b = await db(USER).portfolios.create({ name: "乙" });

    await call(USER, handleSetDefaultPortfolio({ portfolioId: b.id }));

    const out = await call(USER, handleListPortfolios());
    expect(out.defaultId).toBe(b.id);
    expect(out.portfolios.find((p) => p.id === a.id)?.isDefault).toBe(false);
  });

  it("重复设同一个 → 幂等,还是它", async () => {
    await db(USER).portfolios.ensureDefault();
    const b = await db(USER).portfolios.create({ name: "乙" });

    await call(USER, handleSetDefaultPortfolio({ portfolioId: b.id }));
    await call(USER, handleSetDefaultPortfolio({ portfolioId: b.id }));

    expect(await defaults(USER)).toEqual({ id: b.id, count: 1 });
  });

  it("并发设两个不同的 → 结果仍是恰好一个默认", async () => {
    // **这条是清单里最该有的一条。** 「同一时刻只能有一个默认」是个不变量,而实现是
    // 「先把所有 isDefault 清零、再把目标置一」两句放进一个 batch —— 两个请求交错时它究竟稳不稳,
    // 只有并发跑一次才知道。
    await db(USER).portfolios.ensureDefault();
    const b = await db(USER).portfolios.create({ name: "乙" });
    const c = await db(USER).portfolios.create({ name: "丙" });

    await Promise.all([
      call(USER, handleSetDefaultPortfolio({ portfolioId: b.id })),
      call(USER, handleSetDefaultPortfolio({ portfolioId: c.id })),
    ]);

    const out = await defaults(USER);
    expect(out.count).toBe(1);
    expect([b.id, c.id]).toContain(out.id);
  });

  it("设一个不存在的 id → NotFound,原默认不变", async () => {
    const a = await db(USER).portfolios.ensureDefault();

    const exit = await callExit(USER, handleSetDefaultPortfolio({ portfolioId: "没有这个" }));

    expect(failureOf(exit)).toBeInstanceOf(NotFound);
    expect((await defaults(USER)).id).toBe(a.id);
  });

  it("设别人的 Portfolio → NotFound,两边的默认都不变", async () => {
    const mine = await db(USER).portfolios.ensureDefault();
    const theirs = await db(otherUser(USER)).portfolios.ensureDefault();

    const exit = await callExit(USER, handleSetDefaultPortfolio({ portfolioId: theirs.id }));

    expect(failureOf(exit)).toBeInstanceOf(NotFound);
    expect((await defaults(USER)).id).toBe(mine.id);
    expect((await defaults(otherUser(USER))).id).toBe(theirs.id);
  });

  it("portfolioId 空串 → schema 拒", () => {
    expect(SetDefaultPortfolioInput.safeParse({ portfolioId: "" }).success).toBe(false);
  });
});
