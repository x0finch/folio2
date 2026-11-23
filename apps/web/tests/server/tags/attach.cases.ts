import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { AccountTagInput, handleAttachTag } from "@/lib/server/tags/attach";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tags/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tags/attach", () => {
  const USER = "h-tags-attach";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "Alpha",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "Long-term" });
    return { pf, account, tag };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("attachTag", () => {
    it("attach -> the association list shows this account and this tag", async () => {
      const { account, tag } = await seed(USER);

      await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));

      expect(await call(USER, handleListAccountTags())).toEqual([
        expect.objectContaining({ accountId: account.id, tagId: tag.id }),
      ]);
    });

    it("attaching two different tags -> both associations present", async () => {
      const { pf, account, tag } = await seed(USER);
      const second = await db(USER).tags.create({ portfolioId: pf.id, name: "Short-term" });

      await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));
      await call(USER, handleAttachTag({ accountId: account.id, tagId: second.id }));

      expect(await call(USER, handleListAccountTags())).toHaveLength(2);
    });

    it("attaching the same one twice -> idempotent, no duplicate association", async () => {
      const { account, tag } = await seed(USER);

      await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));
      await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));

      expect(await call(USER, handleListAccountTags())).toHaveLength(1);
    });

    it("account belongs to someone else -> rejected, their association list is untouched", async () => {
      const mine = await seed(USER);
      const theirs = await seed(otherUser(USER));

      const exit = await callExit(
        USER,
        handleAttachTag({ accountId: theirs.account.id, tagId: mine.tag.id }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(await call(otherUser(USER), handleListAccountTags())).toEqual([]);
    });

    it("account and tag in different portfolios -> rejected with a clear error, no tag attached", async () => {
      // One ordinary request can reach this combination (the frontend only needs to pass ids of two different portfolios),
      // so it's a typed failure rather than a defect.
      const { account } = await seed(USER);
      const another = await db(USER).portfolios.create({ name: "Another" });
      const foreignTag = await db(USER).tags.create({ portfolioId: another.id, name: "Elsewhere" });

      const exit = await callExit(
        USER,
        handleAttachTag({ accountId: account.id, tagId: foreignTag.id }),
      );

      const failure = failureOf(exit);
      expect(failure?._tag).toBe("db/InvalidInput");
      expect(failure?.message).toContain("different portfolios");
      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });

    it("empty accountId / tagId -> rejected by schema", () => {
      expect(AccountTagInput.safeParse({ accountId: "", tagId: "t" }).success).toBe(false);
      expect(AccountTagInput.safeParse({ accountId: "a", tagId: "" }).success).toBe(false);
    });
  });
});
