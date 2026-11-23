import { beforeEach, describe, expect, it } from "vitest";
import { DeletePortfolioInput, handleDeletePortfolio } from "@/lib/server/portfolios/delete";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

describe("portfolios/delete", () => {
  const USER = "h-pfs-delete";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("deletePortfolio", () => {
    it("deleting an empty one → gone from the list", async () => {
      await db(USER).portfolios.ensureDefault();
      const pf = await db(USER).portfolios.create({ name: "空的" });

      await call(USER, handleDeletePortfolio({ portfolioId: pf.id }));

      const out = await call(USER, handleListPortfolios());
      expect(out.portfolios.map((p) => p.id)).not.toContain(pf.id);
    });

    it("deleting one with members → accounts fall back to the default portfolio", async () => {
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
      const links = await db(USER).portfolios.listMemberships();
      expect(links.find((l) => l.accountId === acc.id)?.portfolioId).toBe(def.id);
    });

    it("deleting the default → rejected with a message, default remains", async () => {
      // A stale tab can still send this request, so it's a typed failure, not a defect.
      const def = await db(USER).portfolios.ensureDefault();

      const exit = await callExit(USER, handleDeletePortfolio({ portfolioId: def.id }));

      const failure = failureOf(exit);
      expect(failure?._tag).toBe("db/InvalidInput");
      expect(failure?.message).toContain("default portfolio cannot be deleted");
      expect((await call(USER, handleListPortfolios())).defaultId).toBe(def.id);
    });

    it("unknown id → NotFound, same as not-yours", async () => {
      await db(USER).portfolios.ensureDefault();

      const exit = await callExit(USER, handleDeletePortfolio({ portfolioId: "没有这个" }));

      expect(failureOf(exit)?._tag).toBe("db/NotFound");
    });

    it("deleting someone else's portfolio → theirs remains", async () => {
      await db(USER).portfolios.ensureDefault();
      const theirs = await db(otherUser(USER)).portfolios.create({ name: "他们的" });

      await callExit(USER, handleDeletePortfolio({ portfolioId: theirs.id }));

      const out = await call(otherUser(USER), handleListPortfolios());
      expect(out.portfolios.map((p) => p.id)).toContain(theirs.id);
    });

    it("empty portfolioId → schema rejects", () => {
      expect(DeletePortfolioInput.safeParse({ portfolioId: "" }).success).toBe(false);
    });
  });
});
