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

    // ADR 0047:上限是**每组合** 3 个,数的是「看得见几个」—— 与 tab 条摆不摆共用同一个纯函数。
    // **一个 pin 会出现在哪些组合由它指向的东西决定,不由调用方声称**(review 抓过一版可绕过的:
    // 收一个 portfolioId 只在那一个组合里数,递空组合的 id 就永远放行)。
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

      // 不用告诉服务端「我在 Watch」:bitcoin 只有 Watch 里有账户,这个 pin 只会出现在那里,
      // 名额也只数那里。
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "bitcoin" }));

      // Watch 里只看得见刚建的那一个;默认组合那三个仍是三个。
      expect(
        (await call(USER, handleGetHomeTabStrip({ portfolioId: watch.id }))).pins,
      ).toHaveLength(1);
      expect((await call(USER, handleGetHomeTabStrip({}))).pins).toHaveLength(3);
    });

    it("目标属于别的组合也绕不过上限(名额跟着 pin 实际出现的组合走)", async () => {
      // 默认组合钉满 3 个;再建一个「指向默认组合里账户」的 pin —— 不管调用方声称什么,
      // 它就会出现在默认组合里,所以被拒。第一版收 portfolioId 时这条能绕过去。
      const { pf, account } = await seed(USER);
      for (const c of ["binance", "okx", "hyperliquid"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }
      // 造一个空组合出来 —— 有它在,「往空组合里数名额」这条歪路才真的存在。
      await db(USER).portfolios.create({ name: "空的" });

      const exit = await callExit(
        USER,
        handleCreateTabPin({ kind: "account", accountId: account.id }),
      );

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
      expect((await call(USER, handleGetHomeTabStrip({}))).pins).toHaveLength(3);
    });

    it("tag pin 与 connector pin 同一套名额(满 3 个之后建 tag pin 也被拒)", async () => {
      const { pf, tag } = await seed(USER);
      for (const c of ["binance", "okx", "hyperliquid"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }

      const exit = await callExit(USER, handleCreateTabPin({ kind: "tag", tagId: tag.id }));

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
    });

    // 上限是**建 / 改指向那一刻**的检查,不是持续维护的不变量:归档一个被 pin 的账户会腾出名额,
    // 建满之后再解归档,那个组合就显示 4 个 tab。**这是接受的漂移** —— 多一个 tab 无害,＋ 号照样
    // 藏着;要挡住它得在归档 / 移动账户那些路径上都挂检查,不值。这条钉住的是「4 个也好好摆着,
    // 不崩、不吞」,免得将来有人把上限当硬不变量,在读路径上加断言。
    it("上限漂移(归档腾位再解归档 → 4 个)是接受的:tab 条照常摆 4 个", async () => {
      const { pf, account } = await seed(USER); // seed 的账户是 manual
      for (const c of ["binance", "okx"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }
      await call(USER, handleCreateTabPin({ kind: "account", accountId: account.id }));
      // 满 3 个。归档被 pin 的账户 → 它的 pin 不摆了,名额空出一个 → 建第 4 个 → 解归档。
      await db(USER).accounts.setArchived(account.id, true);
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "manual" }));
      await db(USER).accounts.setArchived(account.id, false);

      expect((await call(USER, handleGetHomeTabStrip({}))).pins).toHaveLength(4);
    });

    it("kind 不在枚举里 → schema 拒", () => {
      expect(PinTargetInput.safeParse({ kind: "portfolio" }).success).toBe(false);
    });
  });
});
