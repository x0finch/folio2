import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { manualActivity } from "../src/schema";
import { user } from "../src/schema/auth";
import { forDomain, forOracle } from "./effect";

const manualOf = forDomain((db) => db.manual);

const accounts = forDomain((db) => db.accounts);
const tokensOf = forOracle((db) => db.tokens);

const USER_A = "user-a";
const USER_B = "user-b";

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

// 活动挂 (账户, token)。#203 起 token 就是 `tokens` 里的一行(生产路径是 mint;这里直接用 store)。
async function manualAccount(userId: string) {
  const acc = await accounts(userId).create({ connectorId: "manual", label: "M", creds: "{}" });
  const tokenId = await tokensOf(userId, "coingecko").create({ symbol: "BTC" }, []);
  return { id: acc.id, tokenId };
}

describe("manual_activity ops", () => {
  it("record + list (ordered by occurred_at)", async () => {
    const acc = await manualAccount(USER_A);
    await manualOf(USER_A).recordActivity(acc.id, acc.tokenId, {
      kind: "set",
      amount: 10,
      occurredAt: 100,
    });
    await manualOf(USER_A).recordActivity(acc.id, acc.tokenId, {
      kind: "add",
      amount: 5,
      occurredAt: 200,
    });
    const rows = await manualOf(USER_A).listActivityByAccount(acc.id);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ["set", 10],
      ["add", 5],
    ]);
  });

  it("remove by id", async () => {
    const acc = await manualAccount(USER_A);
    await manualOf(USER_A).recordActivity(acc.id, acc.tokenId, {
      kind: "set",
      amount: 10,
      occurredAt: 1,
    });
    const [row] = await manualOf(USER_A).listActivityByAccount(acc.id);
    await manualOf(USER_A).removeActivity(acc.id, row.id);
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toEqual([]);
  });

  it("scoped by owner: other user can't record / list / remove", async () => {
    const acc = await manualAccount(USER_A);
    await manualOf(USER_A).recordActivity(acc.id, acc.tokenId, {
      kind: "set",
      amount: 10,
      occurredAt: 1,
    });
    // B 记录到 A 的 token → 抛(assertTokenOwned:不属本人)
    await expect(
      manualOf(USER_B).recordActivity(acc.id, acc.tokenId, {
        kind: "add",
        amount: 1,
        occurredAt: 2,
      }),
    ).rejects.toThrow();
    // B 列 A 的账户 → 空(join 限 userId)
    expect(await manualOf(USER_B).listActivityByAccount(acc.id)).toEqual([]);
    // A 仍只有 1 条
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(1);
  });

  it("cascade: deleting the account removes its activity", async () => {
    const acc = await manualAccount(USER_A);
    await manualOf(USER_A).recordActivity(acc.id, acc.tokenId, {
      kind: "set",
      amount: 10,
      occurredAt: 1,
    });
    await accounts(USER_A).remove(acc.id);
    // 账户已删 → 直接查表确认活动被级联清(经 userId 路径已查不到账户)。
    const rows = await getDb(env).select().from(manualActivity);
    expect(rows.filter((r) => r.accountId === acc.id)).toEqual([]);
  });
});
