import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";
// 包内白盒:query 实现从内部模块直接引(公开面只出 createDb 门面,见 encapsulation.test)。
import {
  createAccount,
  createManualHolding,
  deleteAccount,
  deleteManualHolding,
  listManualActivityByHolding,
  listManualHoldingsByAccount,
  recordManualActivity,
  updateManualHolding,
} from "../src/queries";
import { manualActivity, manualHolding } from "../src/schema";

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

async function manualAccount(userId: string) {
  return createAccount(env, userId, { connectorId: "manual", label: "M", creds: "{}" });
}

describe("manual_holding ops", () => {
  it("create + list by account", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await createManualHolding(env, USER_A, acc.id, {
      symbol: "BTC",
      unitPrice: 64000,
      identifier: "bitcoin",
    });
    await createManualHolding(env, USER_A, acc.id, { symbol: "ETH", unitPrice: 3200 });
    const rows = await listManualHoldingsByAccount(env, USER_A, acc.id);
    expect(rows.map((r) => [r.symbol, r.unitPrice, r.identifier])).toEqual([
      ["BTC", 64000, "bitcoin"],
      ["ETH", 3200, null],
    ]);
    expect(btc.id).toBeTruthy();
    expect(btc.accountId).toBe(acc.id);
  });

  it("activities belong to a holding; list by holding is ordered by occurred_at", async () => {
    const acc = await manualAccount(USER_A);
    const h = await createManualHolding(env, USER_A, acc.id, { symbol: "BTC", unitPrice: 64000 });
    await recordManualActivity(env, USER_A, h.id, { kind: "add", amount: 5, occurredAt: 200 });
    await recordManualActivity(env, USER_A, h.id, { kind: "set", amount: 10, occurredAt: 100 });
    const rows = await listManualActivityByHolding(env, USER_A, h.id);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ["set", 10],
      ["add", 5],
    ]);
    // accountId 由 holding 反查 → 恒等于 holding 的 account,不接受调用方另传。
    expect(rows.every((r) => r.holdingId === h.id && r.accountId === acc.id)).toBe(true);
  });

  it("rejects recording against a holding the user doesn't own (no cross-account attach)", async () => {
    const acc = await manualAccount(USER_A);
    const h = await createManualHolding(env, USER_A, acc.id, { symbol: "BTC", unitPrice: 64000 });
    // B 不拥有该 holding → 抛(assertHoldingOwned),不会把活动挂到 A 的 holding 上。
    await expect(
      recordManualActivity(env, USER_B, h.id, { kind: "set", amount: 1, occurredAt: 1 }),
    ).rejects.toThrow();
    expect(await listManualActivityByHolding(env, USER_A, h.id)).toEqual([]);
  });

  it("update holding definition (symbol / unitPrice / identifier)", async () => {
    const acc = await manualAccount(USER_A);
    const h = await createManualHolding(env, USER_A, acc.id, { symbol: "FOO", unitPrice: 1 });
    await updateManualHolding(env, USER_A, h.id, {
      symbol: "FOO",
      unitPrice: 2.5,
      identifier: "foo-token",
    });
    const [row] = await listManualHoldingsByAccount(env, USER_A, acc.id);
    expect([row.unitPrice, row.identifier]).toEqual([2.5, "foo-token"]);
  });

  it("delete holding cascades its activities", async () => {
    const acc = await manualAccount(USER_A);
    const h = await createManualHolding(env, USER_A, acc.id, { symbol: "BTC", unitPrice: 64000 });
    await recordManualActivity(env, USER_A, h.id, { kind: "set", amount: 1, occurredAt: 1 });
    await deleteManualHolding(env, USER_A, h.id);
    expect(await listManualHoldingsByAccount(env, USER_A, acc.id)).toEqual([]);
    const acts = await getDb(env).select().from(manualActivity);
    expect(acts.filter((r) => r.holdingId === h.id)).toEqual([]);
  });

  it("scoped by owner: other user can't create / list / update / delete", async () => {
    const acc = await manualAccount(USER_A);
    const h = await createManualHolding(env, USER_A, acc.id, { symbol: "BTC", unitPrice: 64000 });
    await expect(
      createManualHolding(env, USER_B, acc.id, { symbol: "ETH", unitPrice: 3200 }),
    ).rejects.toThrow();
    expect(await listManualHoldingsByAccount(env, USER_B, acc.id)).toEqual([]);
    await expect(
      updateManualHolding(env, USER_B, h.id, { symbol: "X", unitPrice: 9 }),
    ).rejects.toThrow();
    await expect(deleteManualHolding(env, USER_B, h.id)).rejects.toThrow();
    expect(await listManualHoldingsByAccount(env, USER_A, acc.id)).toHaveLength(1);
  });

  it("cascade: deleting the account removes its holdings", async () => {
    const acc = await manualAccount(USER_A);
    await createManualHolding(env, USER_A, acc.id, { symbol: "BTC", unitPrice: 64000 });
    await deleteAccount(env, USER_A, acc.id);
    const rows = await getDb(env).select().from(manualHolding);
    expect(rows.filter((r) => r.accountId === acc.id)).toEqual([]);
  });
});
