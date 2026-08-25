import { beforeEach, describe, expect, it } from "vitest";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tags/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tags/list", () => {
  // #527 · listTags
  const USER = "h-tags-list";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("listTags", () => {
    it("一个 tag 都没有 → 空数组,不是 null", async () => {
      expect(await call(USER, handleListTags())).toEqual([]);
    });

    it("别人的 tag 不会出现在我的清单里", async () => {
      const mine = await db(USER).portfolios.ensureDefault();
      const theirs = await db(otherUser(USER)).portfolios.ensureDefault();
      await db(USER).tags.create({ portfolioId: mine.id, name: "我的" });
      await db(otherUser(USER)).tags.create({ portfolioId: theirs.id, name: "别人的" });

      const tags = await call(USER, handleListTags());

      expect(tags.map((t) => t.name)).toEqual(["我的"]);
    });

    it("tag 所属的 Portfolio 被删掉 → 不返回悬空 tag", async () => {
      const pf = await db(USER).portfolios.create({ name: "要被删的" });
      await db(USER).tags.create({ portfolioId: pf.id, name: "跟着走" });
      await db(USER).portfolios.remove(pf.id);

      expect(await call(USER, handleListTags())).toEqual([]);
    });
  });
});
