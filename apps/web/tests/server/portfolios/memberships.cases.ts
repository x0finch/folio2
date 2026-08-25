import { beforeEach, describe, expect, it } from "vitest";
import { handleListPortfolioMemberships } from "@/lib/server/portfolios/memberships";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolios/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolios/memberships", () => {
  // #527 · listPortfolioMemberships
  const USER = "h-pfs-links";

  const account = (userId: string, label: string) =>
    db(userId).accounts.create({ connectorId: "manual", label, creds: null });

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("listPortfolioMemberships", () => {
    it("三个账户分在两个 Portfolio → 归属关系对得上", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const other = await db(USER).portfolios.create({ name: "另一个" });
      const a = await account(USER, "甲");
      const b = await account(USER, "乙");
      const c = await account(USER, "丙");
      await db(USER).portfolios.assignAccount(a.id, def.id);
      await db(USER).portfolios.assignAccount(b.id, other.id);
      await db(USER).portfolios.assignAccount(c.id, other.id);

      const links = await call(USER, handleListPortfolioMemberships());

      const byAccount = new Map(links.map((l) => [l.accountId, l.portfolioId]));
      expect(byAccount.get(a.id)).toBe(def.id);
      expect(byAccount.get(b.id)).toBe(other.id);
      expect(byAccount.get(c.id)).toBe(other.id);
    });

    it("一个账户都没有 → 空数组,不是 null", async () => {
      await db(USER).portfolios.ensureDefault();

      expect(await call(USER, handleListPortfolioMemberships())).toEqual([]);
    });

    it("建账户时不指定 Portfolio → 自动归到默认那个,不会缺归属", async () => {
      // **实测纠正过一次:** 我原以为「建账户」和「建归属」是两步,缺归属会是个可达状态。
      // 不是 —— `accounts.create` 在同一个 batch 里既落账户行也落归属行(落到 ensureDefault
      // 拿到的那个)。所以「归属悬空的账户」压根构造不出来,这条钉住的就是这个不变量。
      const def = await db(USER).portfolios.ensureDefault();
      const acc = await account(USER, "没指定的");

      const links = await call(USER, handleListPortfolioMemberships());
      expect(links).toEqual([{ accountId: acc.id, portfolioId: def.id }]);
    });

    it("Portfolio 被删 → 它的成员关系不再悬空(改指默认)", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const pf = await db(USER).portfolios.create({ name: "要删的" });
      const a = await account(USER, "甲");
      await db(USER).portfolios.assignAccount(a.id, pf.id);

      await db(USER).portfolios.remove(pf.id);

      const links = await call(USER, handleListPortfolioMemberships());
      expect(links.map((l) => l.portfolioId)).toEqual([def.id]);
    });

    it("账户被删 → 它那条关系一并消失", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const a = await account(USER, "甲");
      await db(USER).portfolios.assignAccount(a.id, def.id);

      await db(USER).accounts.remove(a.id);

      expect(await call(USER, handleListPortfolioMemberships())).toEqual([]);
    });
  });
});
