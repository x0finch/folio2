import { beforeEach, describe, expect, it } from "vitest";
import { CreatePortfolioInput, handleCreatePortfolio } from "@/lib/server/portfolios/create";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolios/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolios/create", () => {
  // #527 · createPortfolio
  const USER = "h-pfs-create";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("createPortfolio", () => {
    it("建一个 → 出现在列表里,而且不是默认", async () => {
      await db(USER).portfolios.ensureDefault();

      const { id } = await call(USER, handleCreatePortfolio({ name: "长线仓" }));

      const out = await call(USER, handleListPortfolios());
      const made = out.portfolios.find((p) => p.id === id);
      expect(made?.name).toBe("长线仓");
      expect(made?.isDefault).toBe(false);
    });

    it("名字两头带空格 → schema trim 之后才进 handler", () => {
      expect(CreatePortfolioInput.parse({ name: "  长线仓  " }).name).toBe("长线仓");
    });

    it("名字空串 / 纯空格 → schema 拒", () => {
      expect(CreatePortfolioInput.safeParse({ name: "" }).success).toBe(false);
      expect(CreatePortfolioInput.safeParse({ name: "    " }).success).toBe(false);
    });

    // #527 裁定 5:每用户内名字唯一(忽略大小写),与 tag 同一道题同一个答案。
    it("重名 → 拒,库里还是一个", async () => {
      await db(USER).portfolios.ensureDefault();
      await call(USER, handleCreatePortfolio({ name: "长线仓" }));

      const exit = await callExit(USER, handleCreatePortfolio({ name: "长线仓" }));

      expect(failureOf(exit)?._tag).toBe("db/InvalidInput");
      const names = (await call(USER, handleListPortfolios())).portfolios.map((p) => p.name);
      expect(names.filter((n) => n === "长线仓")).toHaveLength(1);
    });

    it("只有大小写不同 → 也算重名,拒", async () => {
      await db(USER).portfolios.ensureDefault();
      await call(USER, handleCreatePortfolio({ name: "Defi" }));

      const exit = await callExit(USER, handleCreatePortfolio({ name: "DEFI" }));

      expect(failureOf(exit)?._tag).toBe("db/InvalidInput");
    });

    it("双击提交两次 → 只落一个(唯一索引兜的,不必另铺幂等键)", async () => {
      await db(USER).portfolios.ensureDefault();

      // 两下同时进来:先查后插不原子,所以挡住第二下的是索引本身。
      const both = await Promise.allSettled([
        call(USER, handleCreatePortfolio({ name: "双击" })),
        call(USER, handleCreatePortfolio({ name: "双击" })),
      ]);

      expect(both.some((r) => r.status === "fulfilled")).toBe(true);
      const names = (await call(USER, handleListPortfolios())).portfolios.map((p) => p.name);
      expect(names.filter((n) => n === "双击")).toHaveLength(1);
    });

    it("别人叫这个名字 → 不影响我建同名的(唯一性是每用户的)", async () => {
      await db(otherUser(USER)).portfolios.create({ name: "长线仓" });
      await db(USER).portfolios.ensureDefault();

      const { id } = await call(USER, handleCreatePortfolio({ name: "长线仓" }));

      expect(id).toBeTruthy();
    });

    it("名字 200 字 → 现在照收(schema 没有上限)", async () => {
      // 这条钉的是现状。没有 max 约束,所以超长名字会原样落库,由界面自己截断显示。
      // 如果哪天加了上限,这条会红 —— 那正是提醒把它改成断言「拒」的时刻。
      const long = "长".repeat(200);

      const { id } = await call(USER, handleCreatePortfolio({ name: long }));

      const made = (await call(USER, handleListPortfolios())).portfolios.find((p) => p.id === id);
      expect(made?.name).toHaveLength(200);
    });
  });
});
