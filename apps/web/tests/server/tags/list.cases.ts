import { beforeEach, describe, expect, it } from "vitest";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tags/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tags/list", () => {
  const USER = "h-tags-list";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("listTags", () => {
    it("no tags at all -> empty array, not null", async () => {
      expect(await call(USER, handleListTags())).toEqual([]);
    });

    it("someone else's tags don't appear in my list", async () => {
      const mine = await db(USER).portfolios.ensureDefault();
      const theirs = await db(otherUser(USER)).portfolios.ensureDefault();
      await db(USER).tags.create({ portfolioId: mine.id, name: "Mine" });
      await db(otherUser(USER)).tags.create({ portfolioId: theirs.id, name: "Theirs" });

      const tags = await call(USER, handleListTags());

      expect(tags.map((t) => t.name)).toEqual(["Mine"]);
    });

    it("the tag's portfolio is deleted -> no dangling tag returned", async () => {
      const pf = await db(USER).portfolios.create({ name: "To be deleted" });
      await db(USER).tags.create({ portfolioId: pf.id, name: "Goes with it" });
      await db(USER).portfolios.remove(pf.id);

      expect(await call(USER, handleListTags())).toEqual([]);
    });
  });
});
