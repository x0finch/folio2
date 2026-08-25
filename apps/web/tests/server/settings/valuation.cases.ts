import { beforeEach, describe, expect, it } from "vitest";
import {
  handleGetValuationSettings,
  handleUpdateValuationSettings,
  ValuationInput,
} from "@/lib/server/settings/valuation";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 settings/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("settings/valuation", () => {
  // #527 · getValuationSettings / updateValuationSettings
  const USER = "h-set-valuation";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("getValuationSettings", () => {
    it("从没设过 → 读到默认口径", async () => {
      const settings = await call(USER, handleGetValuationSettings());

      expect(settings.valuationMode).toBeDefined();
      expect(["self-first", "source-first"]).toContain(settings.valuationMode);
    });

    it("读两次结果一样 —— 读接口没有副作用", async () => {
      const first = await call(USER, handleGetValuationSettings());
      const second = await call(USER, handleGetValuationSettings());

      expect(second).toEqual(first);
    });
  });

  describe("updateValuationSettings", () => {
    it("改成 source-first → 再读就是 source-first", async () => {
      await call(USER, handleUpdateValuationSettings({ mode: "source-first" }));

      expect((await call(USER, handleGetValuationSettings())).valuationMode).toBe("source-first");
    });

    it("重复设同一个值 → 幂等", async () => {
      await call(USER, handleUpdateValuationSettings({ mode: "self-first" }));
      await call(USER, handleUpdateValuationSettings({ mode: "self-first" }));

      expect((await call(USER, handleGetValuationSettings())).valuationMode).toBe("self-first");
    });

    it("来回切两次 → 落的是最后那个", async () => {
      await call(USER, handleUpdateValuationSettings({ mode: "source-first" }));
      await call(USER, handleUpdateValuationSettings({ mode: "self-first" }));

      expect((await call(USER, handleGetValuationSettings())).valuationMode).toBe("self-first");
    });

    it("传一个不在枚举里的值 → schema 拒", () => {
      expect(ValuationInput.safeParse({ mode: "whatever" }).success).toBe(false);
      expect(ValuationInput.safeParse({}).success).toBe(false);
    });

    it("改我的不影响别人的", async () => {
      await call(otherUser(USER), handleUpdateValuationSettings({ mode: "source-first" }));

      await call(USER, handleUpdateValuationSettings({ mode: "self-first" }));

      expect((await call(otherUser(USER), handleGetValuationSettings())).valuationMode).toBe(
        "source-first",
      );
    });
  });
});
