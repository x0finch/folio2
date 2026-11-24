import { beforeEach, describe, expect, it } from "vitest";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

describe("portfolios/list", () => {
  const USER = "h-pfs-list";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("listPortfolios", () => {
    it("new user's first call → a default portfolio is created", async () => {
      // ensureDefault must run before list sequentially; concurrently, list could read an empty
      // table and return a default id with no portfolios.
      const out = await call(USER, handleListPortfolios());

      expect(out.portfolios).toHaveLength(1);
      expect(out.portfolios[0].isDefault).toBe(true);
      expect(out.defaultId).toBe(out.portfolios[0].id);
    });

    it("three created → all listed, default flagged", async () => {
      await db(USER).portfolios.ensureDefault();
      await db(USER).portfolios.create({ name: "甲" });
      await db(USER).portfolios.create({ name: "乙" });

      const out = await call(USER, handleListPortfolios());

      expect(out.portfolios).toHaveLength(3);
      expect(out.portfolios.filter((p) => p.isDefault)).toHaveLength(1);
    });

    it("two concurrent first calls → still exactly one default", async () => {
      const [a, b] = await Promise.all([
        call(USER, handleListPortfolios()),
        call(USER, handleListPortfolios()),
      ]);

      expect(a.defaultId).toBe(b.defaultId);
      expect(
        (await call(USER, handleListPortfolios())).portfolios.filter((p) => p.isDefault),
      ).toHaveLength(1);
    });

    it("other users' portfolios aren't listed", async () => {
      await db(otherUser(USER)).portfolios.create({ name: "别人的" });
      await db(otherUser(USER)).portfolios.ensureDefault();

      const out = await call(USER, handleListPortfolios());

      expect(out.portfolios.map((p) => p.name)).not.toContain("别人的");
    });
  });
});
