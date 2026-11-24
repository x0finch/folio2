import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListTags } from "@/lib/server/tags/list";
import { handleRenameTag, RenameTagInput } from "@/lib/server/tags/rename";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tags/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tags/rename", () => {
  const USER = "h-tags-rename";

  const seedTag = async (userId: string, name = "Old name") => {
    const pf = await db(userId).portfolios.ensureDefault();
    return db(userId).tags.create({ portfolioId: pf.id, name });
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("renameTag", () => {
    it("after renaming the list shows the new name", async () => {
      const tag = await seedTag(USER);

      await call(USER, handleRenameTag({ tagId: tag.id, name: "New name" }));

      expect((await call(USER, handleListTags())).map((t) => t.name)).toEqual(["New name"]);
    });

    it("renaming doesn't change ownership -- still under the original portfolio", async () => {
      const tag = await seedTag(USER);

      await call(USER, handleRenameTag({ tagId: tag.id, name: "New name" }));

      expect((await call(USER, handleListTags()))[0].portfolioId).toBe(tag.portfolioId);
    });

    it("rename to empty / whitespace only -> rejected by schema", () => {
      expect(RenameTagInput.safeParse({ tagId: "t1", name: "" }).success).toBe(false);
      expect(RenameTagInput.safeParse({ tagId: "t1", name: "  " }).success).toBe(false);
    });

    it("renaming someone else's tag -> rejected, their name is unchanged", async () => {
      const theirs = await seedTag(otherUser(USER), "Theirs");

      const exit = await callExit(
        USER,
        handleRenameTag({ tagId: theirs.id, name: "Renamed by me" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect((await call(otherUser(USER), handleListTags())).map((t) => t.name)).toEqual([
        "Theirs",
      ]);
    });

    it("rename to a name already in the same portfolio -> rejected, original name kept", async () => {
      // `assertTagNameFree` applies to rename too (excluding itself).
      const pf = await db(USER).portfolios.ensureDefault();
      await db(USER).tags.create({ portfolioId: pf.id, name: "Existing" });
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "Old name" });

      const exit = await callExit(USER, handleRenameTag({ tagId: tag.id, name: "Existing" }));

      expect(Exit.isFailure(exit)).toBe(true);
      expect((await call(USER, handleListTags())).map((t) => t.name).sort()).toEqual([
        "Existing",
        "Old name",
      ]);
    });

    it("rename to its own current name (only whitespace differs) -> allowed, excluding itself avoids a false rejection", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "Long-term" });

      await call(USER, handleRenameTag({ tagId: tag.id, name: "Long-term" }));

      expect((await call(USER, handleListTags()))[0].name).toBe("Long-term");
    });
  });
});
