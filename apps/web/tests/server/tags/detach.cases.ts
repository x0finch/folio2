import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleDetachTag } from "@/lib/server/tags/detach";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tags/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tags/detach", () => {
  // #527 · detachTag
  const USER = "h-tags-detach";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "甲",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "长期" });
    const second = await db(userId).tags.create({ portfolioId: pf.id, name: "短线" });
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
    it("摘掉 → 关联没了,tag 本身还在", async () => {
      const { account, tag } = await seed(USER);

      await call(USER, handleDetachTag({ accountId: account.id, tagId: tag.id }));

      const links = await call(USER, handleListAccountTags());
      expect(links.map((l) => l.tagId)).not.toContain(tag.id);
      expect((await call(USER, handleListTags())).map((t) => t.name).sort()).toEqual([
        "短线",
        "长期",
      ]);
    });

    it("摘掉一个,另一个不受影响", async () => {
      const { account, tag, second } = await seed(USER);

      await call(USER, handleDetachTag({ accountId: account.id, tagId: tag.id }));

      expect(await call(USER, handleListAccountTags())).toEqual([
        expect.objectContaining({ accountId: account.id, tagId: second.id }),
      ]);
    });

    it("摘一个本来没挂的 → 静默幂等,不抛", async () => {
      // 库层是裸 DELETE(注释里也写着「幂等」)。这条钉的是这个选择 —— 界面上重复点「移除」
      // 不该报错。
      const { pf, account } = await seed(USER);
      const unattached = await db(USER).tags.create({ portfolioId: pf.id, name: "没挂过" });

      await call(USER, handleDetachTag({ accountId: account.id, tagId: unattached.id }));

      expect(await call(USER, handleListAccountTags())).toHaveLength(2);
    });

    it("摘别人账户上的 tag → 拒,对方的关联不动", async () => {
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
