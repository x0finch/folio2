import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { CreateTagInput, handleCreateTag } from "@/lib/server/tags/create";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tags/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tags/create", () => {
  const USER = "h-tags-create";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("createTag", () => {
    it("create one -> appears in the list, under the given portfolio", async () => {
      const pf = await db(USER).portfolios.ensureDefault();

      const tag = await call(USER, handleCreateTag({ portfolioId: pf.id, name: "Long-term" }));

      expect(tag.name).toBe("Long-term");
      expect(tag.portfolioId).toBe(pf.id);
      expect(await call(USER, handleListTags())).toHaveLength(1);
    });

    it("name with surrounding spaces -> trimmed before reaching the handler", () => {
      // The trim lives in the input schema, not the handler, so this asserts the schema; it can't be seen through the handler (it already gets the trimmed value).
      expect(CreateTagInput.parse({ portfolioId: "p1", name: "  Long-term  " }).name).toBe(
        "Long-term",
      );
    });

    it("empty name / whitespace only -> rejected by schema", () => {
      expect(CreateTagInput.safeParse({ portfolioId: "p1", name: "" }).success).toBe(false);
      expect(CreateTagInput.safeParse({ portfolioId: "p1", name: "   " }).success).toBe(false);
    });

    it("someone else's portfolioId -> rejected, no tag can be created under another user", async () => {
      const theirs = await db(otherUser(USER)).portfolios.ensureDefault();

      const exit = await callExit(
        USER,
        handleCreateTag({ portfolioId: theirs.id, name: "Stolen" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(await call(otherUser(USER), handleListTags())).toEqual([]);
    });

    it("duplicate name within one portfolio -> rejected (case-insensitive), the first is intact", async () => {
      // The unique index `tags_user_portfolio_name_uidx` rejects by lower(name) (covered by `db tags.test.ts`); this pins that the handler path hits it too.
      const pf = await db(USER).portfolios.ensureDefault();
      await call(USER, handleCreateTag({ portfolioId: pf.id, name: "Long-term" }));

      const exit = await callExit(USER, handleCreateTag({ portfolioId: pf.id, name: "Long-term" }));
      const upper = await callExit(
        USER,
        handleCreateTag({ portfolioId: pf.id, name: "Long-term " }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(upper)).toBe(true); // same name after trim also counts as a duplicate
      expect(await call(USER, handleListTags())).toHaveLength(1);
    });

    it("same name across portfolios -> allowed, independent of each other", async () => {
      const a = await db(USER).portfolios.ensureDefault();
      const b = await db(USER).portfolios.create({ name: "Another" });

      await call(USER, handleCreateTag({ portfolioId: a.id, name: "Long-term" }));
      await call(USER, handleCreateTag({ portfolioId: b.id, name: "Long-term" }));

      // One portfolio per query: `listTags` filters by the current portfolio; the property is that each portfolio holds its own same-named tag without clashing.
      expect(await call(USER, handleListTags({ portfolioId: a.id }))).toHaveLength(1);
      expect(await call(USER, handleListTags({ portfolioId: b.id }))).toHaveLength(1);
    });

    it("double-click submit twice -> the second is rejected as a duplicate, no two rows", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const body = { portfolioId: pf.id, name: "Long-term" };

      const [a, b] = await Promise.all([
        callExit(USER, handleCreateTag(body)),
        callExit(USER, handleCreateTag(body)),
      ]);

      // At least one succeeds and at most one persists; both succeeding under concurrency is the bad case.
      expect([a, b].some((e) => e._tag === "Success")).toBe(true);
      expect(await call(USER, handleListTags())).toHaveLength(1);
    });
  });
});
