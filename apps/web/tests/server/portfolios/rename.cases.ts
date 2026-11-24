import { beforeEach, describe, expect, it } from "vitest";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { handleRenamePortfolio, RenamePortfolioInput } from "@/lib/server/portfolios/rename";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

describe("portfolios/rename", () => {
  const USER = "h-pfs-rename";

  const nameOf = async (userId: string, id: string) =>
    (await call(userId, handleListPortfolios())).portfolios.find((p) => p.id === id)?.name;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("renamePortfolio", () => {
    it("rename → list shows the new name", async () => {
      await db(USER).portfolios.ensureDefault();
      const pf = await db(USER).portfolios.create({ name: "旧名" });

      await call(USER, handleRenamePortfolio({ portfolioId: pf.id, name: "新名" }));

      expect(await nameOf(USER, pf.id)).toBe("新名");
    });

    it("empty / whitespace name → schema rejects", () => {
      expect(RenamePortfolioInput.safeParse({ portfolioId: "p", name: "" }).success).toBe(false);
      expect(RenamePortfolioInput.safeParse({ portfolioId: "p", name: "  " }).success).toBe(false);
    });

    it("renaming someone else's portfolio → their name unchanged", async () => {
      const theirs = await db(otherUser(USER)).portfolios.create({ name: "他们的" });

      await call(USER, handleRenamePortfolio({ portfolioId: theirs.id, name: "被我改了" }));

      expect(await nameOf(otherUser(USER), theirs.id)).toBe("他们的");
    });

    it("unknown id → no throw, nothing created", async () => {
      await db(USER).portfolios.ensureDefault();

      await call(USER, handleRenamePortfolio({ portfolioId: "没有这个", name: "x" }));

      expect((await call(USER, handleListPortfolios())).portfolios).toHaveLength(1);
    });
  });
});
