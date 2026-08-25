import { beforeEach, describe, expect, it } from "vitest";
import { handleGetDataStats } from "@/lib/server/settings/data-stats";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 settings/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("settings/data-stats", () => {
  // #527 · getDataStats
  const USER = "h-set-stats";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("getDataStats", () => {
    it("有账户 → hasData 是 true", async () => {
      await seedAccount(USER, "甲");

      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: true });
    });

    it("全新用户 → hasData 是 false", async () => {
      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: false });
    });

    it("只剩归档账户 → 仍然算「有数据」", async () => {
      // **钉的是现状,而这个规则值得你看一眼(#527 待定项)。** 判据是 `accounts.list().length > 0`,
      // 而 `list()` 把归档的也算进来。这个接口的用途是设置页那句「你有数据,导出/清空按钮可用」——
      // 归档账户确实还有数据可导出,所以「算有」是说得通的;但如果它某天被用来判「是不是新用户」,
      // 这个口径就不对了。
      const acc = await seedAccount(USER, "甲");
      await db(USER).accounts.setArchived(acc.id, true);

      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: true });
    });

    it("别人有数据、我没有 → 我这里必须是 false", async () => {
      await seedAccount(otherUser(USER), "他们的");

      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: false });
    });

    it("账户删干净之后 → 回到 false", async () => {
      const acc = await seedAccount(USER, "甲");
      await db(USER).accounts.remove(acc.id);

      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: false });
    });
  });
});
