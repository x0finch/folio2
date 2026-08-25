import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { AccountTagInput, handleAttachTag } from "@/lib/server/tags/attach";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tags/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tags/attach", () => {
  // #527 · attachTag
  const USER = "h-tags-attach";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "甲",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "长期" });
    return { pf, account, tag };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("attachTag", () => {
    it("挂上 → 关联清单里出现这个账户与这个 tag", async () => {
      const { account, tag } = await seed(USER);

      await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));

      expect(await call(USER, handleListAccountTags())).toEqual([
        expect.objectContaining({ accountId: account.id, tagId: tag.id }),
      ]);
    });

    it("挂两个不同的 tag → 两条关联都在", async () => {
      const { pf, account, tag } = await seed(USER);
      const second = await db(USER).tags.create({ portfolioId: pf.id, name: "短线" });

      await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));
      await call(USER, handleAttachTag({ accountId: account.id, tagId: second.id }));

      expect(await call(USER, handleListAccountTags())).toHaveLength(2);
    });

    it("重复挂同一个 → 幂等,不出现两条一样的关联", async () => {
      const { account, tag } = await seed(USER);

      await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));
      await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));

      expect(await call(USER, handleListAccountTags())).toHaveLength(1);
    });

    it("账户是别人的 → 拒,对方的关联清单不动", async () => {
      const mine = await seed(USER);
      const theirs = await seed(otherUser(USER));

      const exit = await callExit(
        USER,
        handleAttachTag({ accountId: theirs.account.id, tagId: mine.tag.id }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(await call(otherUser(USER), handleListAccountTags())).toEqual([]);
    });

    it("账户与 tag 不在同一个 Portfolio → 拒得有话可说,标签一个没挂上", async () => {
      // #527 裁定 3:这个组合一个普通请求就够得着(前端只要传一对不同 Portfolio 的 id),
      // 所以它是**类型化失败**而不是 defect —— 以前 die,用户拿到一坨 Cause。
      const { account } = await seed(USER);
      const another = await db(USER).portfolios.create({ name: "另一个" });
      const foreignTag = await db(USER).tags.create({ portfolioId: another.id, name: "别处的" });

      const exit = await callExit(
        USER,
        handleAttachTag({ accountId: account.id, tagId: foreignTag.id }),
      );

      const failure = failureOf(exit);
      expect(failure?._tag).toBe("db/InvalidInput");
      expect(failure?.message).toContain("different portfolios");
      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });

    it("accountId / tagId 空串 → schema 拒", () => {
      expect(AccountTagInput.safeParse({ accountId: "", tagId: "t" }).success).toBe(false);
      expect(AccountTagInput.safeParse({ accountId: "a", tagId: "" }).success).toBe(false);
    });
  });
});
