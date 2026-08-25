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

    it("只剩归档账户 → 仍然算「有数据」:这个布尔只答「导入会不会撞上已有数据」,不答「是不是新用户」", async () => {
      // **#527 裁定 7:口径就是这个,别改。** 归档只是退场,数据还在,合并式导入照样会撞上它,
      // 所以「算有」是对的。哪天有人想拿它判「是不是新用户」——一个把全部账户归档了的老用户
      // 在这里是 true,而那个问题的答案该是 false —— 该另开一个 op,不是改这一个。
      // 这条用例的名字就是拦在那次改动前面的东西:改了口径它会红。
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
