import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tags/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tags/account-tags", () => {
  const USER = "h-tags-links";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "Alpha",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const one = await db(userId).tags.create({ portfolioId: pf.id, name: "Long-term" });
    const two = await db(userId).tags.create({ portfolioId: pf.id, name: "Short-term" });
    return { pf, account, one, two };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("listAccountTags", () => {
    it("one account with two tags attached -> both associations present", async () => {
      const { account, one, two } = await seed(USER);
      await db(USER).tags.attach(account.id, one.id);
      await db(USER).tags.attach(account.id, two.id);

      const links = await call(USER, handleListAccountTags());

      expect(links).toHaveLength(2);
      expect(links.map((l) => l.tagId).sort()).toEqual([one.id, two.id].sort());
      expect(new Set(links.map((l) => l.accountId))).toEqual(new Set([account.id]));
    });

    it("no associations at all -> empty array, not null", async () => {
      await seed(USER);

      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });

    it("someone else's associations don't appear in my list", async () => {
      const theirs = await seed(otherUser(USER));
      await db(otherUser(USER)).tags.attach(theirs.account.id, theirs.one.id);
      await seed(USER);

      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });
  });
});
