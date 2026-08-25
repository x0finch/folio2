import { beforeEach, describe, expect, it } from "vitest";
import { DeletePortfolioInput, handleDeletePortfolio } from "@/lib/server/portfolios/delete";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { handleListPortfolioMemberships } from "@/lib/server/portfolios/memberships";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolios/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolios/delete", () => {
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

    it("删默认那个 → 拒得有话可说,默认那个还在", async () => {
      // #527 裁定 4:一个陈旧的页面照样发得出这个请求(另一个标签页刚把它设成默认),
      // 所以是类型化失败,不是 defect —— 以前用户拿到一坨 Cause。
      const def = await db(USER).portfolios.ensureDefault();

      const exit = await callExit(USER, handleDeletePortfolio({ portfolioId: def.id }));

      const failure = failureOf(exit);
      expect(failure?._tag).toBe("db/InvalidInput");
      expect(failure?.message).toContain("default portfolio cannot be deleted");
      expect((await call(USER, handleListPortfolios())).defaultId).toBe(def.id);
    });

    it("删一个不存在的 id → NotFound,与「不是你的」同一句话", async () => {
      await db(USER).portfolios.ensureDefault();

      const exit = await callExit(USER, handleDeletePortfolio({ portfolioId: "没有这个" }));

      expect(failureOf(exit)?._tag).toBe("db/NotFound");
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
});
