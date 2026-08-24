import { InvalidInput, NotFound } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetHomeTabStrip } from "@/lib/server/portfolio/tabs";
import { handleCreateTabPin, PinTargetInput } from "@/lib/server/tab-pins/create";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

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
  it("指向 connector 的 pin → tab 条多一个,名字是连接器的展示名", async () => {
    await seed(USER);

    const pin = await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "manual" }));

    expect(pin.kind).toBe("connector");
    const strip = await call(USER, handleGetHomeTabStrip({}));
    expect(strip.pins).toHaveLength(1);
    expect(strip.pins[0].name).not.toBe("");
  });

  it("指向 tag 的 pin → 标签是 tag 名,不是 tagId", async () => {
    const { tag } = await seed(USER);

    await call(USER, handleCreateTabPin({ kind: "tag", tagId: tag.id }));

    const strip = await call(USER, handleGetHomeTabStrip({}));
    expect(strip.pins[0].name).toBe("长期");
    expect(strip.pins[0].name).not.toBe(tag.id);
  });

  it("指向账户的 pin → 标签是账户名", async () => {
    const { account } = await seed(USER);

    await call(USER, handleCreateTabPin({ kind: "account", accountId: account.id }));

    expect((await call(USER, handleGetHomeTabStrip({}))).pins[0].name).toBe("甲");
  });

  it("已经有三个了再建 → 拒,而且是一句「钉满了」而不是 500", async () => {
    await seed(USER);
    for (const c of ["manual", "bitcoin", "binance"]) {
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
    }

    const exit = await callExit(
      USER,
      handleCreateTabPin({ kind: "connector", connectorId: "okx" }),
    );

    expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
    expect((await call(USER, handleGetHomeTabStrip({}))).pins).toHaveLength(3);
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

  it("kind 与给的 id 对不上(kind=tag 却只给 accountId)→ 一样按缺字段拒", async () => {
    const { account } = await seed(USER);

    const exit = await callExit(USER, handleCreateTabPin({ kind: "tag", accountId: account.id }));

    expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
  });

  it("kind 不在枚举里 → schema 拒", () => {
    expect(PinTargetInput.safeParse({ kind: "portfolio" }).success).toBe(false);
  });
});
