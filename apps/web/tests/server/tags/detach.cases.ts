import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleDetachTag } from "@/lib/server/tags/detach";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tags/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tags/detach", () => {
  const USER = "h-tags-detach";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "Alpha",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "Long-term" });
    const second = await db(userId).tags.create({ portfolioId: pf.id, name: "Short-term" });
    await db(userId).tags.attach(account.id, tag.id);
    await db(userId).tags.attach(account.id, second.id);
    return { pf, account, tag, second };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("detachTag", () => {
    it("detach -> association gone, the tag itself remains", async () => {
      const { account, tag } = await seed(USER);

      await call(USER, handleDetachTag({ accountId: account.id, tagId: tag.id }));

      const links = await call(USER, handleListAccountTags());
      expect(links.map((l) => l.tagId)).not.toContain(tag.id);
      expect((await call(USER, handleListTags())).map((t) => t.name).sort()).toEqual([
        "Short-term",
        "Long-term",
      ]);
    });

    it("detaching one leaves the other unaffected", async () => {
      const { account, tag, second } = await seed(USER);

      await call(USER, handleDetachTag({ accountId: account.id, tagId: tag.id }));

      expect(await call(USER, handleListAccountTags())).toEqual([
        expect.objectContaining({ accountId: account.id, tagId: second.id }),
      ]);
    });

    it("detaching one that was never attached -> silently idempotent, no throw", async () => {
      // The db layer is a bare DELETE (idempotent); this pins that choice: repeatedly clicking "remove" in the UI shouldn't error.
      const { pf, account } = await seed(USER);
      const unattached = await db(USER).tags.create({ portfolioId: pf.id, name: "Never attached" });

      await call(USER, handleDetachTag({ accountId: account.id, tagId: unattached.id }));

      expect(await call(USER, handleListAccountTags())).toHaveLength(2);
    });

    it("detaching a tag from someone else's account -> rejected, their association is untouched", async () => {
      const theirs = await seed(otherUser(USER));

      const exit = await callExit(
        USER,
        handleDetachTag({ accountId: theirs.account.id, tagId: theirs.tag.id }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(await call(otherUser(USER), handleListAccountTags())).toHaveLength(2);
    });
  });
});
