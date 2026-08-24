import { Cause, Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { DeletePortfolioInput, handleDeletePortfolio } from "@/lib/server/portfolios/delete";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { handleListPortfolioMemberships } from "@/lib/server/portfolios/memberships";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// #527 · deletePortfolio
const USER = "h-pfs-delete";

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("deletePortfolio", () => {
  it("删一个空的 → 列表里没了", async () => {
    await db(USER).portfolios.ensureDefault();
    const pf = await db(USER).portfolios.create({ name: "空的" });

    await call(USER, handleDeletePortfolio({ portfolioId: pf.id }));

    const out = await call(USER, handleListPortfolios());
    expect(out.portfolios.map((p) => p.id)).not.toContain(pf.id);
  });

  it("删一个有成员的 → 账户不跟着消失,退回默认 Portfolio", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const pf = await db(USER).portfolios.create({ name: "有人的" });
    const acc = await db(USER).accounts.create({
      connectorId: "manual",
      label: "甲",
      creds: null,
    });
    await db(USER).portfolios.assignAccount(acc.id, pf.id);

    await call(USER, handleDeletePortfolio({ portfolioId: pf.id }));

    expect((await db(USER).accounts.list()).map((a) => a.id)).toContain(acc.id);
    const links = await call(USER, handleListPortfolioMemberships());
    expect(links.find((l) => l.accountId === acc.id)?.portfolioId).toBe(def.id);
  });

  it("删默认那个 → 现在是 defect,不是给用户看的拒", async () => {
    // **钉现状,现状本身待定(#527 待定项)。** 一个陈旧的页面照样发得出这个请求,而库层走的是
    // `Effect.die` —— 用户拿到一坨 Cause,不是「默认 Portfolio 不能删」。与 tags 那条跨 Portfolio
    // 挂标是同一类:够得着的请求被当成了 bug。
    const def = await db(USER).portfolios.ensureDefault();

    const exit = await callExit(USER, handleDeletePortfolio({ portfolioId: def.id }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isDie(exit.cause)).toBe(true);
    expect((await call(USER, handleListPortfolios())).defaultId).toBe(def.id);
  });

  it("删一个不存在的 id → 同样是 defect(现状)", async () => {
    await db(USER).portfolios.ensureDefault();

    const exit = await callExit(USER, handleDeletePortfolio({ portfolioId: "没有这个" }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isDie(exit.cause)).toBe(true);
  });

  it("删别人的 Portfolio → 对方那个还在", async () => {
    await db(USER).portfolios.ensureDefault();
    const theirs = await db(otherUser(USER)).portfolios.create({ name: "他们的" });

    await callExit(USER, handleDeletePortfolio({ portfolioId: theirs.id }));

    const out = await call(otherUser(USER), handleListPortfolios());
    expect(out.portfolios.map((p) => p.id)).toContain(theirs.id);
  });

  it("portfolioId 空串 → schema 拒", () => {
    expect(DeletePortfolioInput.safeParse({ portfolioId: "" }).success).toBe(false);
  });
});
