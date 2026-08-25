import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListTags } from "@/lib/server/tags/list";
import { handleRenameTag, RenameTagInput } from "@/lib/server/tags/rename";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tags/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tags/rename", () => {
  // #527 · renameTag
  const USER = "h-tags-rename";

  const seedTag = async (userId: string, name = "旧名") => {
    const pf = await db(userId).portfolios.ensureDefault();
    return db(userId).tags.create({ portfolioId: pf.id, name });
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("renameTag", () => {
    it("改完列表里是新名字", async () => {
      const tag = await seedTag(USER);

      await call(USER, handleRenameTag({ tagId: tag.id, name: "新名" }));

      expect((await call(USER, handleListTags())).map((t) => t.name)).toEqual(["新名"]);
    });

    it("改名不动归属 —— 还在原来那个 Portfolio 下", async () => {
      const tag = await seedTag(USER);

      await call(USER, handleRenameTag({ tagId: tag.id, name: "新名" }));

      expect((await call(USER, handleListTags()))[0].portfolioId).toBe(tag.portfolioId);
    });

    it("改成空串 / 纯空格 → schema 拒", () => {
      expect(RenameTagInput.safeParse({ tagId: "t1", name: "" }).success).toBe(false);
      expect(RenameTagInput.safeParse({ tagId: "t1", name: "  " }).success).toBe(false);
    });

    it("改别人的 tag → 拒,对方那个名字一个字没变", async () => {
      const theirs = await seedTag(otherUser(USER), "他们的");

      const exit = await callExit(USER, handleRenameTag({ tagId: theirs.id, name: "被我改了" }));

      expect(Exit.isFailure(exit)).toBe(true);
      expect((await call(otherUser(USER), handleListTags())).map((t) => t.name)).toEqual([
        "他们的",
      ]);
    });

    it("改成同 Portfolio 已存在的名字 → 拒,原名保留", async () => {
      // 初稿说这条「待定」—— 错了,`assertTagNameFree` 在 rename 上同样生效(排除自身)。
      const pf = await db(USER).portfolios.ensureDefault();
      await db(USER).tags.create({ portfolioId: pf.id, name: "已存在" });
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "旧名" });

      const exit = await callExit(USER, handleRenameTag({ tagId: tag.id, name: "已存在" }));

      expect(Exit.isFailure(exit)).toBe(true);
      expect((await call(USER, handleListTags())).map((t) => t.name).sort()).toEqual([
        "已存在",
        "旧名",
      ]);
    });

    it("改成自己当前的名字(只动空格)→ 允许,排除自身不误拒", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "长期" });

      await call(USER, handleRenameTag({ tagId: tag.id, name: "长期" }));

      expect((await call(USER, handleListTags()))[0].name).toBe("长期");
    });
  });
});
