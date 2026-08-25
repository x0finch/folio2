import { beforeEach, describe, expect, it } from "vitest";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolios/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolios/list", () => {
  // #527 · listPortfolios
  const USER = "h-pfs-list";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("listPortfolios", () => {
    it("新用户第一次调 → 自动有一个默认 Portfolio(#527 发现 1,已修)", async () => {
      // 修法:ensureDefault 先于 list **顺序**跑 —— 并发时 list 抢跑读到空表,首访返回
      // 「有默认 id、却没有任何 Portfolio」的自相矛盾视图。
      const out = await call(USER, handleListPortfolios());

      expect(out.portfolios).toHaveLength(1);
      expect(out.portfolios[0].isDefault).toBe(true);
      expect(out.defaultId).toBe(out.portfolios[0].id);
    });

    it("第二次调 → 默认 Portfolio 在列表里,且 defaultId 指向它", async () => {
      // 首访那条挂起了,但「稳定态是对的」这件事仍然要有东西钉住。
      await call(USER, handleListPortfolios());

      const out = await call(USER, handleListPortfolios());

      expect(out.portfolios).toHaveLength(1);
      expect(out.portfolios[0].isDefault).toBe(true);
      expect(out.defaultId).toBe(out.portfolios[0].id);
    });

    it("建过三个 → 三个都在,默认那个标出来", async () => {
      await db(USER).portfolios.ensureDefault();
      await db(USER).portfolios.create({ name: "甲" });
      await db(USER).portfolios.create({ name: "乙" });

      const out = await call(USER, handleListPortfolios());

      expect(out.portfolios).toHaveLength(3);
      expect(out.portfolios.filter((p) => p.isDefault)).toHaveLength(1);
    });

    it("并发两次首访 → 仍然恰好一个默认", async () => {
      const [a, b] = await Promise.all([
        call(USER, handleListPortfolios()),
        call(USER, handleListPortfolios()),
      ]);

      expect(a.defaultId).toBe(b.defaultId);
      expect(
        (await call(USER, handleListPortfolios())).portfolios.filter((p) => p.isDefault),
      ).toHaveLength(1);
    });

    it("别人的 Portfolio 不出现在我的清单里", async () => {
      await db(otherUser(USER)).portfolios.create({ name: "别人的" });
      await db(otherUser(USER)).portfolios.ensureDefault();

      const out = await call(USER, handleListPortfolios());

      expect(out.portfolios.map((p) => p.name)).not.toContain("别人的");
    });
  });
});
