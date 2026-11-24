import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { tokens as tokensTable } from "../src/schema";
import { user } from "../src/schema/auth";
import { forDomain, forOracle } from "./effect";

// Manual ledger editing and batch commit (`activityOwner` / `updateActivity` / `commitBatch`): edits overwrite only given fields; others' activity reads as NotFound and stays untouched; a batch lands whole in commit order, and one foreign token aborts the whole batch. Real D1 via the production ticket path (`./effect`).

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
  it("returns which account and coin the activity belongs to", async () => {
    const { acc, row } = await oneActivity(USER_A);
    expect(await manualOf(USER_A).activityOwner(row.id)).toEqual({
      tokenId: acc.tokenId,
      accountId: acc.id,
    });
  });

  it("another user's activity / an unknown id gives NotFound, indistinguishably", async () => {
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
  it("overwrites only given fields; id / account / coin / createdAt untouched", async () => {
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

  it("with one field given, the rest are unchanged", async () => {
    const { acc, row } = await oneActivity(USER_A);
    await manualOf(USER_A).updateActivity(row.id, { memo: "edited" });
    const [after] = await manualOf(USER_A).listActivityByAccount(acc.id);
    expect(after).toEqual({ ...row, memo: "edited" });
  });

  it("an empty patch neither fails nor changes anything, and still returns the ownership", async () => {
    const { acc, row } = await oneActivity(USER_A);
    expect(await manualOf(USER_A).updateActivity(row.id, {})).toEqual({
      tokenId: acc.tokenId,
      accountId: acc.id,
    });
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toEqual([row]);
  });

  it("editing another user's activity gives NotFound and the row is unchanged", async () => {
    const { acc, row } = await oneActivity(USER_A);
    await expect(manualOf(USER_B).updateActivity(row.id, { amount: 999 })).rejects.toThrow(
      "manual activity not found",
    );
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toEqual([row]);
  });
});

describe("commitBatch", () => {
  it("writes the holding declaration (symbol edit) plus a whole batch; same-instant entries sort by commit order", async () => {
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

  it("a foreign coin in the batch writes no row, and my declaration isn't changed either", async () => {
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

  it("committing into another user's account gives NotFound and writes no row", async () => {
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

  it("an empty plan writes nothing and doesn't fail", async () => {
    const acc = await manualAccount(USER_A);
    await manualOf(USER_A).commitBatch({ accountId: acc.id, declare: [], activities: [] });
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toEqual([]);
  });
});
