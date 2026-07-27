import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";
// 包内测试白盒:query 实现从内部模块直接引(公开面只出 createDb 门面,见 encapsulation.test)。
import {
  createAccount,
  deleteAccount,
  listManualActivityByAccount,
  recordManualActivity,
  removeManualActivity,
} from "../src/queries";
import { manualActivity } from "../src/schema";
import { createUserTokenStore } from "../src/user-token-store";

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
  const acc = await createAccount(env, userId, { connectorId: "manual", label: "M", creds: "{}" });
  const tokenId = await createUserTokenStore(env, { userId, namer: "coingecko" }).create(
    { symbol: "BTC" },
    [],
  );
  return { id: acc.id, tokenId };
}

describe("manual_activity ops", () => {
  it("record + list (ordered by occurred_at)", async () => {
    const acc = await manualAccount(USER_A);
    await recordManualActivity(env, USER_A, acc.id, acc.tokenId, {
      kind: "set",
      amount: 10,
      occurredAt: 100,
    });
    await recordManualActivity(env, USER_A, acc.id, acc.tokenId, {
      kind: "add",
      amount: 5,
      occurredAt: 200,
    });
    const rows = await listManualActivityByAccount(env, USER_A, acc.id);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ["set", 10],
      ["add", 5],
    ]);
  });

  it("remove by id", async () => {
    const acc = await manualAccount(USER_A);
    await recordManualActivity(env, USER_A, acc.id, acc.tokenId, {
      kind: "set",
      amount: 10,
      occurredAt: 1,
    });
    const [row] = await listManualActivityByAccount(env, USER_A, acc.id);
    await removeManualActivity(env, USER_A, acc.id, row.id);
    expect(await listManualActivityByAccount(env, USER_A, acc.id)).toEqual([]);
  });

  it("scoped by owner: other user can't record / list / remove", async () => {
    const acc = await manualAccount(USER_A);
    await recordManualActivity(env, USER_A, acc.id, acc.tokenId, {
      kind: "set",
      amount: 10,
      occurredAt: 1,
    });
    // B 记录到 A 的 token → 抛(assertTokenOwned:不属本人)
    await expect(
      recordManualActivity(env, USER_B, acc.id, acc.tokenId, {
        kind: "add",
        amount: 1,
        occurredAt: 2,
      }),
    ).rejects.toThrow();
    // B 列 A 的账户 → 空(join 限 userId)
    expect(await listManualActivityByAccount(env, USER_B, acc.id)).toEqual([]);
    // A 仍只有 1 条
    expect(await listManualActivityByAccount(env, USER_A, acc.id)).toHaveLength(1);
  });

  it("cascade: deleting the account removes its activity", async () => {
    const acc = await manualAccount(USER_A);
    await recordManualActivity(env, USER_A, acc.id, acc.tokenId, {
      kind: "set",
      amount: 10,
      occurredAt: 1,
    });
    await deleteAccount(env, USER_A, acc.id);
    // 账户已删 → 直接查表确认活动被级联清(经 userId 路径已查不到账户)。
    const rows = await getDb(env).select().from(manualActivity);
    expect(rows.filter((r) => r.accountId === acc.id)).toEqual([]);
  });
});
