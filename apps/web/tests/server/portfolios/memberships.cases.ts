import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { freshUser, otherUser } from "../_kit/user";

describe("portfolios/memberships", () => {
  // Membership invariants, read via the domain op directly (no server fn exposes the table).
  const USER = "h-pfs-links";

  const account = (userId: string, label: string) =>
    db(userId).accounts.create({ connectorId: "manual", label, creds: null });

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  const memberships = () => db(USER).portfolios.listMemberships();

  describe("membership invariants", () => {
    it("three accounts across two portfolios → memberships match", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const other = await db(USER).portfolios.create({ name: "另一个" });
      const a = await account(USER, "甲");
      const b = await account(USER, "乙");
      const c = await account(USER, "丙");
      await db(USER).portfolios.assignAccount(a.id, def.id);
      await db(USER).portfolios.assignAccount(b.id, other.id);
      await db(USER).portfolios.assignAccount(c.id, other.id);

      const links = await memberships();

      const byAccount = new Map(links.map((l) => [l.accountId, l.portfolioId]));
      expect(byAccount.get(a.id)).toBe(def.id);
      expect(byAccount.get(b.id)).toBe(other.id);
      expect(byAccount.get(c.id)).toBe(other.id);
    });

    it("no accounts → empty array, not null", async () => {
      await db(USER).portfolios.ensureDefault();

      expect(await memberships()).toEqual([]);
    });

    it("account created without a portfolio → joins the default, never orphaned", async () => {
      // `accounts.create` writes the account and its membership in one batch, so an orphaned
      // account can't be constructed.
      const def = await db(USER).portfolios.ensureDefault();
      const acc = await account(USER, "没指定的");

      expect(await memberships()).toEqual([{ accountId: acc.id, portfolioId: def.id }]);
    });

    it("account deleted → its membership goes too", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const a = await account(USER, "甲");
      await db(USER).portfolios.assignAccount(a.id, def.id);

      await db(USER).accounts.remove(a.id);

      expect(await memberships()).toEqual([]);
    });
  });
});
