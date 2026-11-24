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

describe("portfolios/set-default", () => {
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
    it("set B as default → B is default, A no longer", async () => {
      const a = await db(USER).portfolios.ensureDefault();
      const b = await db(USER).portfolios.create({ name: "乙" });

      await call(USER, handleSetDefaultPortfolio({ portfolioId: b.id }));

      const out = await call(USER, handleListPortfolios());
      expect(out.defaultId).toBe(b.id);
      expect(out.portfolios.find((p) => p.id === a.id)?.isDefault).toBe(false);
    });

    it("setting the same one again → idempotent", async () => {
      await db(USER).portfolios.ensureDefault();
      const b = await db(USER).portfolios.create({ name: "乙" });

      await call(USER, handleSetDefaultPortfolio({ portfolioId: b.id }));
      await call(USER, handleSetDefaultPortfolio({ portfolioId: b.id }));

      expect(await defaults(USER)).toEqual({ id: b.id, count: 1 });
    });

    it("two concurrent different defaults → still exactly one default", async () => {
      // Clear-all-then-set runs as one batch; only a concurrent run shows it holds under interleaving.
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

    it("unknown id → NotFound, default unchanged", async () => {
      const a = await db(USER).portfolios.ensureDefault();

      const exit = await callExit(USER, handleSetDefaultPortfolio({ portfolioId: "没有这个" }));

      expect(failureOf(exit)).toBeInstanceOf(NotFound);
      expect((await defaults(USER)).id).toBe(a.id);
    });

    it("empty portfolioId → schema rejects", () => {
      expect(SetDefaultPortfolioInput.safeParse({ portfolioId: "" }).success).toBe(false);
    });
  });
});
