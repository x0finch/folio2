import { InvalidInput, NotFound } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdateTabPinTarget, UpdateTabPinInput } from "@/lib/server/tab-pins/update-target";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf, readTabStrip } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tab-pins/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tab-pins/update-target", () => {
  // #527 · updateTabPinTarget
  const USER = "h-pins-update";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "甲",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "长期" });
    const pin = await db(userId).tabPins.create({ kind: "connector", connectorId: "manual" });
    return { pf, account, tag, pin };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("updateTabPinTarget", () => {
    it("从 connector 改成 tag → tab 条上的标签跟着变", async () => {
      const { pin, tag } = await seed(USER);

      await call(USER, handleUpdateTabPinTarget({ pinId: pin.id, kind: "tag", tagId: tag.id }));

      const strip = await readTabStrip(USER, {});
      expect(strip.pins[0].name).toBe("长期");
      expect(strip.pins[0].kind).toBe("tag");
    });

    it("改完还是同一个 pin —— id 不变、不多出一个", async () => {
      const { pin, account } = await seed(USER);

      await call(
        USER,
        handleUpdateTabPinTarget({ pinId: pin.id, kind: "account", accountId: account.id }),
      );

      const strip = await readTabStrip(USER, {});
      expect(strip.pins).toHaveLength(1);
      expect(strip.pins[0].id).toBe(pin.id);
    });

    it("改成三个 pin 里中间那个 → 另外两个的顺序不动", async () => {
      const { tag } = await seed(USER);
      // 每个被 pin 的 connector 都得在这个组合里有账户,否则那个 pin 压根不摆(ADR 0047)。
      for (const c of ["bitcoin", "binance"] as const) {
        await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
      }
      const second = await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "binance" });
      const before = (await readTabStrip(USER, {})).pins.map((p) => p.id);

      await call(USER, handleUpdateTabPinTarget({ pinId: second.id, kind: "tag", tagId: tag.id }));

      expect((await readTabStrip(USER, {})).pins.map((p) => p.id)).toEqual(before);
    });

    // review 抓的洞:改指向以前一句校验都没有 —— 把 pin 改指向一个 connector,它会出现在
    // 别的组合里,把那边顶到 4 个,而那边的 ＋ 因为 >=3 藏着,界面自相矛盾。
    it("改指向也过上限:新目标会把某个组合顶到 4 个 → 拒,原指向保留", async () => {
      const { pf } = await seed(USER); // seed 里已有 1 个 manual pin
      for (const c of ["binance", "okx"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await db(USER).tabPins.create({ kind: "connector", connectorId: c });
      }
      // 默认组合现在满 3 个。另一个组合里有个 pin,把它改指向默认组合里的 connector → 拒。
      const watch = await db(USER).portfolios.create({ name: "Watch" });
      const there = await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "那边的",
        creds: null,
      });
      await db(USER).portfolios.assignAccount(there.id, watch.id);
      const watchPin = await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

      const exit = await callExit(
        USER,
        handleUpdateTabPinTarget({ pinId: watchPin.id, kind: "connector", connectorId: "okx" }),
      );

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
      // 原指向保留:Watch 里那个还是 bitcoin。
      const strip = await readTabStrip(USER, { portfolioId: watch.id });
      expect(strip.pins.map((p) => p.connectorId)).toEqual(["bitcoin"]);
    });

    it("改指向不与自己抢名额:满 3 个的组合里改其中一个,照样能改", async () => {
      const { pf, tag } = await seed(USER);
      for (const c of ["binance", "okx"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await db(USER).tabPins.create({ kind: "connector", connectorId: c });
      }
      const pins = await db(USER).tabPins.list();
      // 满 3 个;把其中一个改指向同组合的 tag —— 旧的那次出现不占名额,这一下必须能过。
      await call(USER, handleUpdateTabPinTarget({ pinId: pins[0].id, kind: "tag", tagId: tag.id }));

      expect((await readTabStrip(USER, {})).pins).toHaveLength(3);
    });

    it("改成指向别人的 tag → 拒,原指向保留", async () => {
      const { pin } = await seed(USER);
      const theirs = await seed(otherUser(USER));

      const exit = await callExit(
        USER,
        handleUpdateTabPinTarget({ pinId: pin.id, kind: "tag", tagId: theirs.tag.id }),
      );

      expect(failureOf(exit)).toBeInstanceOf(NotFound);
      expect((await readTabStrip(USER, {})).pins[0].kind).toBe("connector");
    });

    it("pinId 空串 → schema 拒", () => {
      expect(UpdateTabPinInput.safeParse({ pinId: "", kind: "connector" }).success).toBe(false);
    });
  });
});
