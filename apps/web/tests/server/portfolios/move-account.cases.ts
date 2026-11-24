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

describe("portfolios/move-account", () => {
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
    it("move → membership changes, gone from the source portfolio", async () => {
      const { def, target, account } = await seed(USER);

      await call(
        USER,
        handleMoveAccountToPortfolio({ accountId: account.id, portfolioId: target.id }),
      );

      expect(await whereIs(USER, account.id)).toBe(target.id);
      expect(await whereIs(USER, account.id)).not.toBe(def.id);
    });

    it("move with newName → new portfolio created and used", async () => {
      const { account } = await seed(USER);

      await call(USER, handleMoveAccountToPortfolio({ accountId: account.id, newName: "新仓" }));

      const out = await call(USER, handleListPortfolios());
      const made = out.portfolios.find((p) => p.name === "新仓");
      expect(made).toBeDefined();
      expect(await whereIs(USER, account.id)).toBe(made?.id);
    });

    it("move to its current portfolio → idempotent, not an error", async () => {
      const { def, account } = await seed(USER);

      await call(
        USER,
        handleMoveAccountToPortfolio({ accountId: account.id, portfolioId: def.id }),
      );

      expect(await whereIs(USER, account.id)).toBe(def.id);
      expect(await db(USER).portfolios.listMemberships()).toHaveLength(1);
    });

    it("neither portfolioId nor newName → schema rejects", () => {
      expect(MoveAccountInput.safeParse({ accountId: "a" }).success).toBe(false);
    });

    it("both given → newName wins", async () => {
      // Pins the precedence; flipping it would file the account into the old portfolio on "create new".
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

    it("target portfolio belongs to someone else → NotFound, account not moved", async () => {
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
