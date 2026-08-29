import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { DeleteTagInput, handleDeleteTag } from "@/lib/server/tags/delete";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readTabStrip } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tags/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tags/delete", () => {
  // #527 · deleteTag
  const USER = "h-tags-delete";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "长期" });
    return { pf, tag };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("deleteTag", () => {
    it("删一个没人挂着的 → 列表里不再有它", async () => {
      const { tag } = await seed(USER);

      await call(USER, handleDeleteTag({ tagId: tag.id }));

      expect(await call(USER, handleListTags())).toEqual([]);
    });

    it("删一个正挂在两个账户上的 → tag 没了,两个账户还在,只是不再有这个标", async () => {
      const { pf, tag } = await seed(USER);
      const a = await db(USER).accounts.create({ connectorId: "manual", label: "甲", creds: null });
      const b = await db(USER).accounts.create({ connectorId: "manual", label: "乙", creds: null });
      await db(USER).portfolios.assignAccount(a.id, pf.id);
      await db(USER).portfolios.assignAccount(b.id, pf.id);
      await db(USER).tags.attach(a.id, tag.id);
      await db(USER).tags.attach(b.id, tag.id);

      await call(USER, handleDeleteTag({ tagId: tag.id }));

      expect(await call(USER, handleListAccountTags())).toEqual([]);
      expect((await db(USER).accounts.list()).map((x) => x.label).sort()).toEqual(["乙", "甲"]);
    });

    it("同一个 tagId 再删一次 → 静默幂等,结果跟第一次一样", async () => {
      const { tag } = await seed(USER);

      await call(USER, handleDeleteTag({ tagId: tag.id }));
      await call(USER, handleDeleteTag({ tagId: tag.id })); // 不抛

      expect(await call(USER, handleListTags())).toEqual([]);
    });

    it("有个首页 pin 正指着这个 tag → 删完 tab 条不出现指向空气的 tab", async () => {
      const { pf, tag } = await seed(USER);
      const acc = await db(USER).accounts.create({
        connectorId: "manual",
        label: "甲",
        creds: null,
      });
      await db(USER).portfolios.assignAccount(acc.id, pf.id);
      await db(USER).tags.attach(acc.id, tag.id);
      await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });

      await call(USER, handleDeleteTag({ tagId: tag.id }));

      // pin 行随 tag 级联删除(`tab_pins.tag_id` 是 ON DELETE CASCADE),所以 tab 条上直接没有它 ——
      // 不是「留着一个名字为空的 pin」。这条正是要钉住这个级联。
      expect((await readTabStrip(USER, {})).pins).toEqual([]);
    });

    it("删别人的 tagId → 对方那个 tag 一根毛都没掉", async () => {
      const theirs = await seed(otherUser(USER));

      await call(USER, handleDeleteTag({ tagId: theirs.tag.id }));

      expect((await call(otherUser(USER), handleListTags())).map((t) => t.name)).toEqual(["长期"]);
    });

    it("tagId 空串 → schema 拒", () => {
      expect(DeleteTagInput.safeParse({ tagId: "" }).success).toBe(false);
    });
  });
});
