import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { AccountStore, PortfolioStore, TagStore } from "../src/domains";
import { user } from "../src/schema/auth";
import { forDomain, forUser } from "./effect";

// tab-pins 已经挂进聚合 `Database`(#504 T1),所以把手从聚合取字段;**断言一行没动**。
const tabPinsOf = forDomain((db) => db.tabPins);
const tagsOf = forUser(TagStore, TagStore.Default);

const accounts = forUser(AccountStore, AccountStore.Default);
const portfolios = forUser(PortfolioStore, PortfolioStore.Default);

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
    const pf = await portfolios(USER_A).ensureDefault();
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "长线" });
    const cp = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    expect(cp.connectorId).toBe("binance");
    expect(cp.tagId).toBeNull();
    const tp = await tabPinsOf(USER_A).create({ kind: "tag", tagId: tag.id });
    expect(tp.tagId).toBe(tag.id);
    expect(tp.connectorId).toBeNull();
    expect(await tabPinsOf(USER_A).list()).toHaveLength(2);
  });

  it("建 account pin,只 account_id 非空", async () => {
    await portfolios(USER_A).ensureDefault();
    const acc = await accounts(USER_A).create({
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    const ap = await tabPinsOf(USER_A).create({ kind: "account", accountId: acc.id });
    expect(ap.accountId).toBe(acc.id);
    expect(ap.tagId).toBeNull();
    expect(ap.connectorId).toBeNull();
  });

  it("tag pin 缺 tagId / connector pin 缺 connectorId / account pin 缺 accountId → 拒", async () => {
    await portfolios(USER_A).ensureDefault();
    await expect(tabPinsOf(USER_A).create({ kind: "tag" })).rejects.toThrow();
    await expect(tabPinsOf(USER_A).create({ kind: "connector" })).rejects.toThrow();
    await expect(tabPinsOf(USER_A).create({ kind: "account" })).rejects.toThrow();
  });

  it("account pin 指向他人账户 → 拒", async () => {
    await portfolios(USER_B).ensureDefault();
    const accB = await accounts(USER_B).create({ connectorId: "okx", label: "x", creds: "y" });
    await expect(
      tabPinsOf(USER_A).create({ kind: "account", accountId: accB.id }),
    ).rejects.toThrow();
  });

  it("tag pin 指向他人 Tag → 拒", async () => {
    const pfB = await portfolios(USER_B).create({ name: "B's" });
    const tagB = await tagsOf(USER_B).create({ portfolioId: pfB.id, name: "x" });
    await expect(tabPinsOf(USER_A).create({ kind: "tag", tagId: tagB.id })).rejects.toThrow();
  });

  it("每 user 至多 3 个,第 4 个被拒", async () => {
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "okx" });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "hyperliquid" });
    await expect(
      tabPinsOf(USER_A).create({ kind: "connector", connectorId: "manual" }),
    ).rejects.toThrow();
    expect(await tabPinsOf(USER_A).list()).toHaveLength(3);
  });
});

describe("cascade / 存活", () => {
  it("删 Tag → 其 tag pin 经 FK cascade 删除", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "长线" });
    await tabPinsOf(USER_A).create({ kind: "tag", tagId: tag.id });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    expect(await tabPinsOf(USER_A).list()).toHaveLength(2);
    await tagsOf(USER_A).remove(tag.id);
    const left = await tabPinsOf(USER_A).list();
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe("connector"); // 只剩 connector pin
  });

  it("删账户 → 其 account pin 经 FK cascade 删除;connector pin 不受影响", async () => {
    await portfolios(USER_A).ensureDefault();
    const acc = await accounts(USER_A).create({
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    await tabPinsOf(USER_A).create({ kind: "account", accountId: acc.id });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    expect(await tabPinsOf(USER_A).list()).toHaveLength(2);
    await accounts(USER_A).remove(acc.id);
    const left = await tabPinsOf(USER_A).list();
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe("connector");
  });

  it("connector pin 名下账户被删光 → pin 仍在(无 FK,显示空)", async () => {
    await portfolios(USER_A).ensureDefault();
    const acc = await accounts(USER_A).create({
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    await accounts(USER_A).remove(acc.id);
    expect(await tabPinsOf(USER_A).list()).toHaveLength(1); // pin 存活
  });
});

describe("update / reorder / delete + 越权", () => {
  it("updateTabPinTarget 换指向(connector → tag)", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "长线" });
    const pin = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    await tabPinsOf(USER_A).updateTarget(pin.id, { kind: "tag", tagId: tag.id });
    const [after] = await tabPinsOf(USER_A).list();
    expect(after!.kind).toBe("tag");
    expect(after!.tagId).toBe(tag.id);
    expect(after!.connectorId).toBeNull();
  });

  it("reorderTabPins 按给定顺序写 sortOrder", async () => {
    const a = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    const b = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "okx" });
    await tabPinsOf(USER_A).reorder([b.id, a.id]);
    expect((await tabPinsOf(USER_A).list()).map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("deleteTabPin 取消固定;越权改/删他人 pin 无效", async () => {
    const pin = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    // B 改 A 的 pin → 断言失败抛。
    await expect(
      tabPinsOf(USER_B).updateTarget(pin.id, { kind: "connector", connectorId: "okx" }),
    ).rejects.toThrow();
    // B 删 A 的 pin → 作用域限定,影响 0 行(不抛),A 的 pin 仍在。
    await tabPinsOf(USER_B).remove(pin.id);
    expect(await tabPinsOf(USER_A).list()).toHaveLength(1);
    // A 删自己的 → 没了。
    await tabPinsOf(USER_A).remove(pin.id);
    expect(await tabPinsOf(USER_A).list()).toHaveLength(0);
  });
});
