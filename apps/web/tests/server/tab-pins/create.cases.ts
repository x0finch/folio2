import { InvalidInput, NotFound } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetHomeTabStrip } from "@/lib/server/portfolio/tabs";
import { handleCreateTabPin, PinTargetInput } from "@/lib/server/tab-pins/create";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tab-pins/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tab-pins/create", () => {
  // #527 · createTabPin
  const USER = "h-pins-create";

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

  describe("createTabPin", () => {
    it("指向 tag 的 pin → 标签是 tag 名,不是 tagId", async () => {
      const { tag } = await seed(USER);

      await call(USER, handleCreateTabPin({ kind: "tag", tagId: tag.id }));

      const strip = await call(USER, handleGetHomeTabStrip({}));
      expect(strip.pins[0].name).toBe("长期");
      expect(strip.pins[0].name).not.toBe(tag.id);
    });

    it("指向别人的 tag → 拒,不许建出跨用户的 pin", async () => {
      await seed(USER);
      const theirs = await seed(otherUser(USER));

      const exit = await callExit(USER, handleCreateTabPin({ kind: "tag", tagId: theirs.tag.id }));

      expect(failureOf(exit)).toBeInstanceOf(NotFound);
      expect((await call(USER, handleGetHomeTabStrip({}))).pins).toEqual([]);
    });

    it("kind=tag 但没带 tagId → InvalidInput,不是 defect", async () => {
      // 入参 schema 三个目标字段全是可选的(一个 schema 供三种 kind),所以这个组合进得来。
      // 它是调用方拼错参数,该收到一句话。
      await seed(USER);

      const exit = await callExit(USER, handleCreateTabPin({ kind: "tag" }));

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
    });

    // ADR 0047:上限是**每组合** 3 个,而且数的是「这个组合里看得见几个」—— 与 tab 条摆不摆共用同一个
    // 纯函数。以前是每 user 3 个,于是在默认组合钉满之后,别的组合明明空着也建不了,界面还说「钉满了」。
    it("这个组合钉满 3 个 → 第 4 个被拒(类型化失败,不是 500)", async () => {
      const { pf } = await seed(USER);
      for (const c of ["binance", "okx", "hyperliquid"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }

      const exit = await callExit(
        USER,
        handleCreateTabPin({ kind: "connector", connectorId: "manual" }),
      );

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
      expect((await call(USER, handleGetHomeTabStrip({}))).pins).toHaveLength(3);
    });

    it("A 组合钉满,B 组合照样能建(名额按组合各算)", async () => {
      const { pf } = await seed(USER);
      for (const c of ["binance", "okx", "hyperliquid"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }
      const watch = await db(USER).portfolios.create({ name: "Watch" });
      const there = await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "那边的",
        creds: null,
      });
      await db(USER).portfolios.assignAccount(there.id, watch.id);

      await call(
        USER,
        handleCreateTabPin({ kind: "connector", connectorId: "bitcoin", portfolioId: watch.id }),
      );

      // Watch 里只看得见刚建的那一个;默认组合那三个仍是三个。
      expect(
        (await call(USER, handleGetHomeTabStrip({ portfolioId: watch.id }))).pins,
      ).toHaveLength(1);
      expect((await call(USER, handleGetHomeTabStrip({}))).pins).toHaveLength(3);
    });

    it("kind 不在枚举里 → schema 拒", () => {
      expect(PinTargetInput.safeParse({ kind: "portfolio" }).success).toBe(false);
    });
  });
});
