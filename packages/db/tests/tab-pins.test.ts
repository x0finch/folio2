import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import {
  createAccount,
  createPortfolio,
  createTabPin,
  createTag,
  deleteAccount,
  deleteTabPin,
  deleteTag,
  ensureDefaultPortfolio,
  listTabPinsByUser,
  reorderTabPins,
  updateTabPinTarget,
} from "../src/queries";
import { user } from "../src/schema/auth";

// 自定义 Tab pin 地基(ADR 0034)对着真 D1 跑:≤3 上限 / tag pin FK cascade / connector pin 无 FK 存活 /
// owner 断言都真生效。不隔离每测存储 → beforeEach 重置用户。

const USER_A = "user-a";
const USER_B = "user-b";

async function resetUser(userId: string, name = userId): Promise<void> {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
  await db.insert(user).values({
    id: userId,
    name,
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

describe("createTabPin", () => {
  it("建 connector pin / tag pin,两列互斥非空", async () => {
    const pf = await ensureDefaultPortfolio(env, USER_A);
    const tag = await createTag(env, USER_A, { portfolioId: pf.id, name: "长线" });
    const cp = await createTabPin(env, USER_A, { kind: "connector", connectorId: "binance" });
    expect(cp.connectorId).toBe("binance");
    expect(cp.tagId).toBeNull();
    const tp = await createTabPin(env, USER_A, { kind: "tag", tagId: tag.id });
    expect(tp.tagId).toBe(tag.id);
    expect(tp.connectorId).toBeNull();
    expect(await listTabPinsByUser(env, USER_A)).toHaveLength(2);
  });

  it("建 account pin,只 account_id 非空", async () => {
    await ensureDefaultPortfolio(env, USER_A);
    const acc = await createAccount(env, USER_A, {
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    const ap = await createTabPin(env, USER_A, { kind: "account", accountId: acc.id });
    expect(ap.accountId).toBe(acc.id);
    expect(ap.tagId).toBeNull();
    expect(ap.connectorId).toBeNull();
  });

  it("tag pin 缺 tagId / connector pin 缺 connectorId / account pin 缺 accountId → 拒", async () => {
    await ensureDefaultPortfolio(env, USER_A);
    await expect(createTabPin(env, USER_A, { kind: "tag" })).rejects.toThrow();
    await expect(createTabPin(env, USER_A, { kind: "connector" })).rejects.toThrow();
    await expect(createTabPin(env, USER_A, { kind: "account" })).rejects.toThrow();
  });

  it("account pin 指向他人账户 → 拒", async () => {
    await ensureDefaultPortfolio(env, USER_B);
    const accB = await createAccount(env, USER_B, { connectorId: "okx", label: "x", creds: "y" });
    await expect(
      createTabPin(env, USER_A, { kind: "account", accountId: accB.id }),
    ).rejects.toThrow();
  });

  it("tag pin 指向他人 Tag → 拒", async () => {
    const pfB = await createPortfolio(env, USER_B, { name: "B's" });
    const tagB = await createTag(env, USER_B, { portfolioId: pfB.id, name: "x" });
    await expect(createTabPin(env, USER_A, { kind: "tag", tagId: tagB.id })).rejects.toThrow();
  });

  it("每 user 至多 3 个,第 4 个被拒", async () => {
    await createTabPin(env, USER_A, { kind: "connector", connectorId: "binance" });
    await createTabPin(env, USER_A, { kind: "connector", connectorId: "okx" });
    await createTabPin(env, USER_A, { kind: "connector", connectorId: "hyperliquid" });
    await expect(
      createTabPin(env, USER_A, { kind: "connector", connectorId: "manual" }),
    ).rejects.toThrow();
    expect(await listTabPinsByUser(env, USER_A)).toHaveLength(3);
  });
});

describe("cascade / 存活", () => {
  it("删 Tag → 其 tag pin 经 FK cascade 删除", async () => {
    const pf = await ensureDefaultPortfolio(env, USER_A);
    const tag = await createTag(env, USER_A, { portfolioId: pf.id, name: "长线" });
    await createTabPin(env, USER_A, { kind: "tag", tagId: tag.id });
    await createTabPin(env, USER_A, { kind: "connector", connectorId: "binance" });
    expect(await listTabPinsByUser(env, USER_A)).toHaveLength(2);
    await deleteTag(env, USER_A, tag.id);
    const left = await listTabPinsByUser(env, USER_A);
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe("connector"); // 只剩 connector pin
  });

  it("删账户 → 其 account pin 经 FK cascade 删除;connector pin 不受影响", async () => {
    await ensureDefaultPortfolio(env, USER_A);
    const acc = await createAccount(env, USER_A, {
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    await createTabPin(env, USER_A, { kind: "account", accountId: acc.id });
    await createTabPin(env, USER_A, { kind: "connector", connectorId: "binance" });
    expect(await listTabPinsByUser(env, USER_A)).toHaveLength(2);
    await deleteAccount(env, USER_A, acc.id);
    const left = await listTabPinsByUser(env, USER_A);
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe("connector");
  });

  it("connector pin 名下账户被删光 → pin 仍在(无 FK,显示空)", async () => {
    await ensureDefaultPortfolio(env, USER_A);
    const acc = await createAccount(env, USER_A, {
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    await createTabPin(env, USER_A, { kind: "connector", connectorId: "binance" });
    await deleteAccount(env, USER_A, acc.id);
    expect(await listTabPinsByUser(env, USER_A)).toHaveLength(1); // pin 存活
  });
});

describe("update / reorder / delete + 越权", () => {
  it("updateTabPinTarget 换指向(connector → tag)", async () => {
    const pf = await ensureDefaultPortfolio(env, USER_A);
    const tag = await createTag(env, USER_A, { portfolioId: pf.id, name: "长线" });
    const pin = await createTabPin(env, USER_A, { kind: "connector", connectorId: "binance" });
    await updateTabPinTarget(env, USER_A, pin.id, { kind: "tag", tagId: tag.id });
    const [after] = await listTabPinsByUser(env, USER_A);
    expect(after!.kind).toBe("tag");
    expect(after!.tagId).toBe(tag.id);
    expect(after!.connectorId).toBeNull();
  });

  it("reorderTabPins 按给定顺序写 sortOrder", async () => {
    const a = await createTabPin(env, USER_A, { kind: "connector", connectorId: "binance" });
    const b = await createTabPin(env, USER_A, { kind: "connector", connectorId: "okx" });
    await reorderTabPins(env, USER_A, [b.id, a.id]);
    expect((await listTabPinsByUser(env, USER_A)).map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("deleteTabPin 取消固定;越权改/删他人 pin 无效", async () => {
    const pin = await createTabPin(env, USER_A, { kind: "connector", connectorId: "binance" });
    // B 改 A 的 pin → 断言失败抛。
    await expect(
      updateTabPinTarget(env, USER_B, pin.id, { kind: "connector", connectorId: "okx" }),
    ).rejects.toThrow();
    // B 删 A 的 pin → 作用域限定,影响 0 行(不抛),A 的 pin 仍在。
    await deleteTabPin(env, USER_B, pin.id);
    expect(await listTabPinsByUser(env, USER_A)).toHaveLength(1);
    // A 删自己的 → 没了。
    await deleteTabPin(env, USER_A, pin.id);
    expect(await listTabPinsByUser(env, USER_A)).toHaveLength(0);
  });
});
