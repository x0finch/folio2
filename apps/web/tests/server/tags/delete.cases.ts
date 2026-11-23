import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { DeleteTagInput, handleDeleteTag } from "@/lib/server/tags/delete";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readTabStrip } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tags/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tags/delete", () => {
  const USER = "h-tags-delete";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "Long-term" });
    return { pf, tag };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("deleteTag", () => {
    it("deleting a tag attached to two accounts -> tag gone, both accounts remain, just without the tag", async () => {
      const { pf, tag } = await seed(USER);
      const a = await db(USER).accounts.create({
        connectorId: "manual",
        label: "Alpha",
        creds: null,
      });
      const b = await db(USER).accounts.create({
        connectorId: "manual",
        label: "Beta",
        creds: null,
      });
      await db(USER).portfolios.assignAccount(a.id, pf.id);
      await db(USER).portfolios.assignAccount(b.id, pf.id);
      await db(USER).tags.attach(a.id, tag.id);
      await db(USER).tags.attach(b.id, tag.id);

      await call(USER, handleDeleteTag({ tagId: tag.id }));

      expect(await call(USER, handleListAccountTags())).toEqual([]);
      expect((await db(USER).accounts.list()).map((x) => x.label).sort()).toEqual([
        "Beta",
        "Alpha",
      ]);
    });

    it("deleting the same tagId again -> silently idempotent, same result as the first time", async () => {
      const { tag } = await seed(USER);

      await call(USER, handleDeleteTag({ tagId: tag.id }));
      await call(USER, handleDeleteTag({ tagId: tag.id })); // does not throw

      expect(await call(USER, handleListTags())).toEqual([]);
    });

    it("a home pin points at this tag -> after deletion the tab strip has no tab pointing at nothing", async () => {
      const { pf, tag } = await seed(USER);
      const acc = await db(USER).accounts.create({
        connectorId: "manual",
        label: "Alpha",
        creds: null,
      });
      await db(USER).portfolios.assignAccount(acc.id, pf.id);
      await db(USER).tags.attach(acc.id, tag.id);
      await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });

      await call(USER, handleDeleteTag({ tagId: tag.id }));

      // The pin row is cascade-deleted with the tag (`tab_pins.tag_id` is ON DELETE CASCADE), so the tab strip simply lacks it,
      // rather than keeping a pin with an empty name; this pins that cascade.
      expect((await readTabStrip(USER, {})).pins).toEqual([]);
    });

    it("deleting someone else's tagId -> their tag loses nothing", async () => {
      const theirs = await seed(otherUser(USER));

      await call(USER, handleDeleteTag({ tagId: theirs.tag.id }));

      expect((await call(otherUser(USER), handleListTags())).map((t) => t.name)).toEqual([
        "Long-term",
      ]);
    });

    it("empty tagId -> rejected by schema", () => {
      expect(DeleteTagInput.safeParse({ tagId: "" }).success).toBe(false);
    });
  });
});
