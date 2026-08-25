import { InvalidInput, NotFound } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetHomeTabStrip } from "@/lib/server/portfolio/tabs";
import { handleUpdateTabPinTarget, UpdateTabPinInput } from "@/lib/server/tab-pins/update-target";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

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

    const strip = await call(USER, handleGetHomeTabStrip({}));
    expect(strip.pins[0].name).toBe("长期");
    expect(strip.pins[0].kind).toBe("tag");
  });

  it("改完还是同一个 pin —— id 不变、不多出一个", async () => {
    const { pin, account } = await seed(USER);

    await call(
      USER,
      handleUpdateTabPinTarget({ pinId: pin.id, kind: "account", accountId: account.id }),
    );

    const strip = await call(USER, handleGetHomeTabStrip({}));
    expect(strip.pins).toHaveLength(1);
    expect(strip.pins[0].id).toBe(pin.id);
  });

  it("改成三个 pin 里中间那个 → 另外两个的顺序不动", async () => {
    const { tag } = await seed(USER);
    const second = await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });
    await db(USER).tabPins.create({ kind: "connector", connectorId: "binance" });
    const before = (await call(USER, handleGetHomeTabStrip({}))).pins.map((p) => p.id);

    await call(USER, handleUpdateTabPinTarget({ pinId: second.id, kind: "tag", tagId: tag.id }));

    expect((await call(USER, handleGetHomeTabStrip({}))).pins.map((p) => p.id)).toEqual(before);
  });

  it("改成指向别人的 tag → 拒,原指向保留", async () => {
    const { pin } = await seed(USER);
    const theirs = await seed(otherUser(USER));

    const exit = await callExit(
      USER,
      handleUpdateTabPinTarget({ pinId: pin.id, kind: "tag", tagId: theirs.tag.id }),
    );

    expect(failureOf(exit)).toBeInstanceOf(NotFound);
    expect((await call(USER, handleGetHomeTabStrip({}))).pins[0].kind).toBe("connector");
  });

  it("改别人的 pinId → 拒,对方那个 pin 不动", async () => {
    await seed(USER);
    const theirs = await seed(otherUser(USER));

    const exit = await callExit(
      USER,
      handleUpdateTabPinTarget({ pinId: theirs.pin.id, kind: "connector", connectorId: "okx" }),
    );

    expect(Boolean(failureOf(exit))).toBe(true);
    const theirStrip = await call(otherUser(USER), handleGetHomeTabStrip({}));
    expect(theirStrip.pins[0].connectorId).toBe("manual");
  });

  it("kind 换了但没带对应的 id → InvalidInput", async () => {
    const { pin } = await seed(USER);

    const exit = await callExit(USER, handleUpdateTabPinTarget({ pinId: pin.id, kind: "tag" }));

    expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
  });

  it("pinId 空串 → schema 拒", () => {
    expect(UpdateTabPinInput.safeParse({ pinId: "", kind: "connector" }).success).toBe(false);
  });
});
