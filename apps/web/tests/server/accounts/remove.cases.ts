import { beforeEach, describe, expect, it } from "vitest";
import { handleRemoveAccount, RemoveAccountInput } from "@/lib/server/accounts/remove";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleListTags } from "@/lib/server/tags/list";
import { countRows, db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readOverview, readTabStrip } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 accounts/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("accounts/remove", () => {
  // #527 · removeAccount(库层级联)
  const USER = "h-acc-remove";
  const BTC = "token-btc";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("removeAccount", () => {
    it("删掉挂着 tag 的账户 → tag 本身还在,只是不再关联它", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await db(USER).portfolios.assignAccount(acc.id, pf.id);
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "长期" });
      await db(USER).tags.attach(acc.id, tag.id);

      await call(USER, handleRemoveAccount({ accountId: acc.id }));

      expect(await call(USER, handleListTags())).toHaveLength(1);
      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });

    it("删掉首页 pin 正指着的账户 → tab 条不出现指向空气的 tab", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await db(USER).tabPins.create({ kind: "account", accountId: acc.id });

      await call(USER, handleRemoveAccount({ accountId: acc.id }));

      expect((await readTabStrip(USER, {})).pins).toEqual([]);
    });

    it("删掉某 Portfolio 的唯一成员 → Portfolio 还在,只是空了", async () => {
      const pf = await db(USER).portfolios.create({ name: "只有一个成员" });
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await db(USER).portfolios.assignAccount(acc.id, pf.id);

      await call(USER, handleRemoveAccount({ accountId: acc.id }));

      expect((await db(USER).portfolios.list()).map((p) => p.id)).toContain(pf.id);
    });

    it("删完立刻取总览 → 总额里不再含它", async () => {
      const keep = await seedAccount(USER, "留着", "bitcoin");
      await seedSnapshot(USER, keep.id, Date.now(), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      const gone = await seedAccount(USER, "删掉", "bitcoin");
      await seedSnapshot(USER, gone.id, Date.now(), [{ tokenId: BTC, amount: 1, usdValue: 900 }]);

      await call(USER, handleRemoveAccount({ accountId: gone.id }));

      expect((await readOverview(USER, {})).totalUsd).toBe(100);
    });

    it("删一个不存在的 id → 静默幂等(与其他删除同一规则)", async () => {
      await call(USER, handleRemoveAccount({ accountId: "没有这个" }));

      expect(await countRows("accounts", USER)).toBe(0);
    });

    it("删别人的账户 → 对方那个还在", async () => {
      const theirs = await seedAccount(otherUser(USER), "他们的", "bitcoin");

      await call(USER, handleRemoveAccount({ accountId: theirs.id }));

      expect(await countRows("accounts", otherUser(USER))).toBe(1);
    });

    it("accountId 空串 → schema 拒", () => {
      expect(RemoveAccountInput.safeParse({ accountId: "" }).success).toBe(false);
    });
  });
});
