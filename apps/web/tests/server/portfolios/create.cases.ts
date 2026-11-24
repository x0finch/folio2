import { beforeEach, describe, expect, it } from "vitest";
import { CreatePortfolioInput, handleCreatePortfolio } from "@/lib/server/portfolios/create";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

describe("portfolios/create", () => {
  const USER = "h-pfs-create";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("createPortfolio", () => {
    it("create → listed, not default", async () => {
      await db(USER).portfolios.ensureDefault();

      const { id } = await call(USER, handleCreatePortfolio({ name: "长线仓" }));

      const out = await call(USER, handleListPortfolios());
      const made = out.portfolios.find((p) => p.id === id);
      expect(made?.name).toBe("长线仓");
      expect(made?.isDefault).toBe(false);
    });

    it("name with surrounding spaces → trimmed by schema", () => {
      expect(CreatePortfolioInput.parse({ name: "  长线仓  " }).name).toBe("长线仓");
    });

    it("empty / whitespace name → schema rejects", () => {
      expect(CreatePortfolioInput.safeParse({ name: "" }).success).toBe(false);
      expect(CreatePortfolioInput.safeParse({ name: "    " }).success).toBe(false);
    });

    // Names are unique per user, case-insensitive (same rule as tags).
    it("duplicate name → rejected, still one row", async () => {
      await db(USER).portfolios.ensureDefault();
      await call(USER, handleCreatePortfolio({ name: "长线仓" }));

      const exit = await callExit(USER, handleCreatePortfolio({ name: "长线仓" }));

      expect(failureOf(exit)?._tag).toBe("db/InvalidInput");
      const names = (await call(USER, handleListPortfolios())).portfolios.map((p) => p.name);
      expect(names.filter((n) => n === "长线仓")).toHaveLength(1);
    });

    it("differs only in case → still a duplicate, rejected", async () => {
      await db(USER).portfolios.ensureDefault();
      await call(USER, handleCreatePortfolio({ name: "Defi" }));

      const exit = await callExit(USER, handleCreatePortfolio({ name: "DEFI" }));

      expect(failureOf(exit)?._tag).toBe("db/InvalidInput");
    });

    it("double submit → one row (enforced by the unique index)", async () => {
      await db(USER).portfolios.ensureDefault();

      // Check-then-insert isn't atomic, so the index itself stops the second insert.
      const both = await Promise.allSettled([
        call(USER, handleCreatePortfolio({ name: "双击" })),
        call(USER, handleCreatePortfolio({ name: "双击" })),
      ]);

      expect(both.some((r) => r.status === "fulfilled")).toBe(true);
      const names = (await call(USER, handleListPortfolios())).portfolios.map((p) => p.name);
      expect(names.filter((n) => n === "双击")).toHaveLength(1);
    });

    it("another user has the name → I can still use it (uniqueness is per user)", async () => {
      await db(otherUser(USER)).portfolios.create({ name: "长线仓" });
      await db(USER).portfolios.ensureDefault();

      const { id } = await call(USER, handleCreatePortfolio({ name: "长线仓" }));

      expect(id).toBeTruthy();
    });

    it("200-char name → accepted (schema has no max)", async () => {
      // Pins current behaviour: no max length; flip this to a rejection if one is added.
      const long = "长".repeat(200);

      const { id } = await call(USER, handleCreatePortfolio({ name: long }));

      const made = (await call(USER, handleListPortfolios())).portfolios.find((p) => p.id === id);
      expect(made?.name).toHaveLength(200);
    });
  });
});
