import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tags/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tags/account-tags", () => {
  // #527 · listAccountTags
  const USER = "h-tags-links";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "甲",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const one = await db(userId).tags.create({ portfolioId: pf.id, name: "长期" });
    const two = await db(userId).tags.create({ portfolioId: pf.id, name: "短线" });
    return { pf, account, one, two };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("listAccountTags", () => {
    it("一个账户挂两个 tag → 两条关联都在", async () => {
      const { account, one, two } = await seed(USER);
      await db(USER).tags.attach(account.id, one.id);
      await db(USER).tags.attach(account.id, two.id);

      const links = await call(USER, handleListAccountTags());

      expect(links).toHaveLength(2);
      expect(links.map((l) => l.tagId).sort()).toEqual([one.id, two.id].sort());
      expect(new Set(links.map((l) => l.accountId))).toEqual(new Set([account.id]));
    });

    it("没有任何关联 → 空数组,不是 null", async () => {
      await seed(USER);

      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });

    it("账户被删 → 它那条关联不再返回(不留悬空)", async () => {
      const { account, one } = await seed(USER);
      await db(USER).tags.attach(account.id, one.id);

      await db(USER).accounts.remove(account.id);

      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });

    it("别人的关联不出现在我的清单里", async () => {
      const theirs = await seed(otherUser(USER));
      await db(otherUser(USER)).tags.attach(theirs.account.id, theirs.one.id);
      await seed(USER);

      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });
  });
});
