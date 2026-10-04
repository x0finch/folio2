import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { tokens as tokensTable } from "../src/schema";
import { user } from "../src/schema/auth";
import { forDomain, forOracle } from "./effect";

// 手记账本的**编辑与批量提交**(`activityOwner` / `updateActivity` / `commitBatch`):
//   · 编辑只覆盖给定字段,id / 账户 / 币 / createdAt 不动;空 patch 不写库也不炸;
//   · 别人的活动 —— 定位、编辑都当「不存在」(NotFound),行原样不动;
//   · 批量提交整批落库、按提交序排;混进一个别人的币 → 整批一行都不落。
// 真 D1(Miniflare),跑的是生产那条门票 → 服务的路(`./effect`)。

const manualOf = forDomain((db) => db.manual);
const accounts = forDomain((db) => db.accounts);
const tokensOf = forOracle((db) => db.tokens);

const USER_A = "user-manual-edit-a";
const USER_B = "user-manual-edit-b";

async function resetUser(userId: string): Promise<void> {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
  await db.insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  await resetUser(USER_A);
  await resetUser(USER_B);
});

async function manualAccount(userId: string, symbol = "BTC") {
  const acc = await accounts(userId).create({ connectorId: "manual", label: "M", creds: "{}" });
  const tokenId = await tokensOf(userId, "coingecko").create({ symbol }, []);
  return { id: acc.id, tokenId };
}

async function oneActivity(userId: string) {
  const acc = await manualAccount(userId);
  await manualOf(userId).recordActivity(acc.id, acc.tokenId, {
    kind: "add",
    amount: 10,
    price: 100,
    fee: 1,
    occurredAt: 500,
    memo: "first",
    createdAt: 42,
  });
  const [row] = await manualOf(userId).listActivityByAccount(acc.id);
  if (!row) throw new Error("seed failed");
  return { acc, row };
}

describe("activityOwner", () => {
  it("回这条活动挂在哪个账户、哪个币上", async () => {
    const { acc, row } = await oneActivity(USER_A);
    expect(await manualOf(USER_A).activityOwner(row.id)).toEqual({
      tokenId: acc.tokenId,
      accountId: acc.id,
    });
  });

  it("别人的活动 / 不存在的 id → NotFound,两者长得一样", async () => {
    const { row } = await oneActivity(USER_A);
    await expect(manualOf(USER_B).activityOwner(row.id)).rejects.toThrow(
      `manual activity not found: ${row.id}`,
    );
    await expect(manualOf(USER_A).activityOwner("nope")).rejects.toThrow(
      "manual activity not found: nope",
    );
  });
});

describe("updateActivity", () => {
  it("只覆盖给定字段;id / 账户 / 币 / createdAt 不动", async () => {
    const { acc, row } = await oneActivity(USER_A);

    const owner = await manualOf(USER_A).updateActivity(row.id, {
      kind: "reduce",
      amount: 3,
      price: null,
      fee: 2,
      occurredAt: 900,
      memo: null,
    });

    expect(owner).toEqual({ tokenId: acc.tokenId, accountId: acc.id });
    const [after] = await manualOf(USER_A).listActivityByAccount(acc.id);
    expect(after).toEqual({
      ...row,
      kind: "reduce",
      amount: 3,
      price: null,
      fee: 2,
      occurredAt: 900,
      memo: null,
    });
  });

  it("只给一个字段 → 其余原样", async () => {
    const { acc, row } = await oneActivity(USER_A);
    await manualOf(USER_A).updateActivity(row.id, { memo: "edited" });
    const [after] = await manualOf(USER_A).listActivityByAccount(acc.id);
    expect(after).toEqual({ ...row, memo: "edited" });
  });

  it("空 patch → 不炸、不改,照样回归属", async () => {
    const { acc, row } = await oneActivity(USER_A);
    expect(await manualOf(USER_A).updateActivity(row.id, {})).toEqual({
      tokenId: acc.tokenId,
      accountId: acc.id,
    });
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toEqual([row]);
  });

  it("改别人的活动 → NotFound,那一行原样", async () => {
    const { acc, row } = await oneActivity(USER_A);
    await expect(manualOf(USER_B).updateActivity(row.id, { amount: 999 })).rejects.toThrow(
      "manual activity not found",
    );
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toEqual([row]);
  });
});

describe("commitBatch", () => {
  it("落持仓声明(改 symbol)+ 整批活动,同一时刻的按提交序排", async () => {
    const acc = await manualAccount(USER_A, "old");
    const eth = await tokensOf(USER_A, "coingecko").create({ symbol: "ETH" }, []);

    await manualOf(USER_A).commitBatch({
      accountId: acc.id,
      declare: [{ id: acc.tokenId, symbol: "MYBTC" }],
      activities: [
        { tokenId: acc.tokenId, kind: "set", amount: 1, occurredAt: 100 },
        { tokenId: eth, kind: "add", amount: 2, price: 3000, fee: 1, occurredAt: 100, memo: "m" },
        { tokenId: acc.tokenId, kind: "add", amount: 4, occurredAt: 100 },
      ],
    });

    const rows = await manualOf(USER_A).listActivityByAccount(acc.id);
    expect(rows.map((r) => [r.tokenId, r.kind, r.amount, r.price, r.fee, r.memo])).toEqual([
      [acc.tokenId, "set", 1, null, null, null],
      [eth, "add", 2, 3000, 1, "m"],
      [acc.tokenId, "add", 4, null, null, null],
    ]);
    const [tok] = await getDb(env)
      .select({ symbol: tokensTable.symbol })
      .from(tokensTable)
      .where(eq(tokensTable.id, acc.tokenId));
    expect(tok?.symbol).toBe("MYBTC");
  });

  it("混进一个别人的币 → 整批一行都不落,我的声明也不改", async () => {
    const acc = await manualAccount(USER_A, "mine");
    const theirs = await tokensOf(USER_B, "coingecko").create({ symbol: "X" }, []);

    await expect(
      manualOf(USER_A).commitBatch({
        accountId: acc.id,
        declare: [{ id: acc.tokenId, symbol: "renamed" }],
        activities: [
          { tokenId: acc.tokenId, kind: "set", amount: 1, occurredAt: 1 },
          { tokenId: theirs, kind: "set", amount: 1, occurredAt: 1 },
        ],
      }),
    ).rejects.toThrow(`token not owned: ${theirs}`);

    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toEqual([]);
    const [tok] = await getDb(env)
      .select({ symbol: tokensTable.symbol })
      .from(tokensTable)
      .where(eq(tokensTable.id, acc.tokenId));
    expect(tok?.symbol).toBe("mine");
  });

  it("往别人的账户里提交 → NotFound,一行都不落", async () => {
    const theirs = await manualAccount(USER_B);
    const mine = await tokensOf(USER_A, "coingecko").create({ symbol: "BTC" }, []);

    await expect(
      manualOf(USER_A).commitBatch({
        accountId: theirs.id,
        declare: [],
        activities: [{ tokenId: mine, kind: "set", amount: 1, occurredAt: 1 }],
      }),
    ).rejects.toThrow("not found");
    expect(await manualOf(USER_B).listActivityByAccount(theirs.id)).toEqual([]);
  });

  it("空计划 → 什么都不写,不炸", async () => {
    const acc = await manualAccount(USER_A);
    await manualOf(USER_A).commitBatch({ accountId: acc.id, declare: [], activities: [] });
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toEqual([]);
  });
});
