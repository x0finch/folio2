import { NotFound } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import {
  handleMoveAccountToPortfolio,
  MoveAccountInput,
} from "@/lib/server/portfolios/move-account";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolios/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolios/move-account", () => {
  // #527 · moveAccountToPortfolio
  const USER = "h-pfs-move";

  const whereIs = async (userId: string, accountId: string) =>
    (await db(userId).portfolios.listMemberships()).find((l) => l.accountId === accountId)
      ?.portfolioId;

  const seed = async (userId: string) => {
    const def = await db(userId).portfolios.ensureDefault();
    const target = await db(userId).portfolios.create({ name: "目标" });
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "甲",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, def.id);
    return { def, target, account };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("moveAccountToPortfolio", () => {
    it("移过去 → 归属变了,原 Portfolio 里没它了", async () => {
      const { def, target, account } = await seed(USER);

      await call(
        USER,
        handleMoveAccountToPortfolio({ accountId: account.id, portfolioId: target.id }),
      );

      expect(await whereIs(USER, account.id)).toBe(target.id);
      expect(await whereIs(USER, account.id)).not.toBe(def.id);
    });

    it("带 newName 移 → 新建一个 Portfolio 并落进去", async () => {
      const { account } = await seed(USER);

      await call(USER, handleMoveAccountToPortfolio({ accountId: account.id, newName: "新仓" }));

      const out = await call(USER, handleListPortfolios());
      const made = out.portfolios.find((p) => p.name === "新仓");
      expect(made).toBeDefined();
      expect(await whereIs(USER, account.id)).toBe(made?.id);
    });

    it("移到它已经在的那个 → 幂等,不是报错", async () => {
      const { def, account } = await seed(USER);

      await call(
        USER,
        handleMoveAccountToPortfolio({ accountId: account.id, portfolioId: def.id }),
      );

      expect(await whereIs(USER, account.id)).toBe(def.id);
      expect(await db(USER).portfolios.listMemberships()).toHaveLength(1);
    });

    it("portfolioId 和 newName 都不给 → schema 拒", () => {
      expect(MoveAccountInput.safeParse({ accountId: "a" }).success).toBe(false);
    });

    it("两个都给 → newName 赢,新建那个才是落脚点", async () => {
      // 代码已定优先级(`data.newName ? 新建 : portfolioId`),这条把它钉住 —— 否则将来有人
      // 「顺手」换成 portfolioId 优先,界面上会变成「点了新建却落进了旧仓」。
      const { target, account } = await seed(USER);

      await call(
        USER,
        handleMoveAccountToPortfolio({
          accountId: account.id,
          portfolioId: target.id,
          newName: "新仓",
        }),
      );

      const made = (await call(USER, handleListPortfolios())).portfolios.find(
        (p) => p.name === "新仓",
      );
      expect(await whereIs(USER, account.id)).toBe(made?.id);
      expect(await whereIs(USER, account.id)).not.toBe(target.id);
    });

    it("目标 Portfolio 是别人的 → NotFound,账户不许落到别人名下", async () => {
      const { def, account } = await seed(USER);
      const theirs = await seed(otherUser(USER));

      const exit = await callExit(
        USER,
        handleMoveAccountToPortfolio({ accountId: account.id, portfolioId: theirs.target.id }),
      );

      expect(failureOf(exit)).toBeInstanceOf(NotFound);
      expect(await whereIs(USER, account.id)).toBe(def.id);
    });
  });
});
