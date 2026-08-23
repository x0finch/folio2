import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

const tagsOf = forDomain((db) => db.tags);

const accounts = forDomain((db) => db.accounts);
const portfolios = forDomain((db) => db.portfolios);

// Tag 数据地基(ADR 0034)对着真 D1 跑:表达式唯一索引 / cascade / 同 batch 清 tag 都真生效。
// 不隔离每测存储 → beforeEach 重置用户(级联清 portfolios/tags/account_tags)。

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

async function makeAccount(userId: string, label = "A") {
  return accounts(userId).create({ connectorId: "manual", label, creds: "x" });
}

beforeEach(async () => {
  await resetUser(USER_A);
  await resetUser(USER_B);
});

describe("createTag / list", () => {
  it("建 Tag 归属指定 Portfolio,名字 trim 后落库", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "  长线  " });
    expect(tag.name).toBe("长线");
    expect(tag.portfolioId).toBe(pf.id);
    expect(await tagsOf(USER_A).listByPortfolio(pf.id)).toHaveLength(1);
    expect(await tagsOf(USER_A).list()).toHaveLength(1);
  });

  it("空名(或纯空格)被拒", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    await expect(tagsOf(USER_A).create({ portfolioId: pf.id, name: "   " })).rejects.toThrow();
  });

  it("在他人 Portfolio 建 Tag → 拒(assertPortfolioOwned)", async () => {
    const pfB = await portfolios(USER_B).create({ name: "B's" });
    await expect(tagsOf(USER_A).create({ portfolioId: pfB.id, name: "x" })).rejects.toThrow();
  });
});

describe("同 Portfolio 内名字唯一(忽略大小写/空格)", () => {
  it("同名(trim 后)重复 → 拒", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    await tagsOf(USER_A).create({ portfolioId: pf.id, name: "长线" });
    await expect(tagsOf(USER_A).create({ portfolioId: pf.id, name: " 长线 " })).rejects.toThrow();
  });

  it("大小写不同也算重复 → 拒", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Defi" });
    await expect(tagsOf(USER_A).create({ portfolioId: pf.id, name: "DEFI" })).rejects.toThrow();
  });

  it("跨 Portfolio 同名 → 允许", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await tagsOf(USER_A).create({ portfolioId: def.id, name: "长线" });
    await tagsOf(USER_A).create({ portfolioId: watch.id, name: "长线" });
    expect(await tagsOf(USER_A).list()).toHaveLength(2);
  });

  it("表达式唯一索引兜底:绕过 ops 直插大小写变体 → 撞 tags_user_portfolio_name_uidx", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    await tagsOf(USER_A).create({ portfolioId: pf.id, name: "abc" });
    await expect(
      env.DB.prepare(
        "INSERT INTO tags (id, user_id, portfolio_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, 0, 0)",
      )
        .bind("dup-tag", USER_A, pf.id, "ABC")
        .run(),
    ).rejects.toThrow();
  });
});

describe("renameTag", () => {
  it("改名成功;改成同 Portfolio 已存在的别名 → 拒", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const a = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "长线" });
    await tagsOf(USER_A).create({ portfolioId: pf.id, name: "短线" });
    await tagsOf(USER_A).rename(a.id, "中线");
    expect((await tagsOf(USER_A).list()).map((t) => t.name).sort()).toEqual(["中线", "短线"]);
    await expect(tagsOf(USER_A).rename(a.id, "短线")).rejects.toThrow();
  });

  it("改成自身当前名(仅大小写变化)→ 允许(排除自身)", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const a = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "defi" });
    await tagsOf(USER_A).rename(a.id, "DeFi");
    expect((await tagsOf(USER_A).list())[0]!.name).toBe("DeFi");
  });
});

describe("attach / detach", () => {
  it("打上/取消;attach 幂等", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "长线" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    await tagsOf(USER_A).attach(acc.id, tag.id); // 幂等
    expect(await tagsOf(USER_A).listAccountLinks()).toEqual([{ accountId: acc.id, tagId: tag.id }]);
    await tagsOf(USER_A).detach(acc.id, tag.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(0);
  });

  it("attach 一个与账户不同 Portfolio 的 Tag → 拒", async () => {
    await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A); // 落默认 Portfolio
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    const tag = await tagsOf(USER_A).create({ portfolioId: watch.id, name: "长线" });
    await expect(tagsOf(USER_A).attach(acc.id, tag.id)).rejects.toThrow();
  });

  it("越权:动他人账户 / 他人 Tag → 拒", async () => {
    const pfA = await portfolios(USER_A).ensureDefault();
    const accA = await makeAccount(USER_A);
    const tagA = await tagsOf(USER_A).create({ portfolioId: pfA.id, name: "长线" });
    await expect(tagsOf(USER_B).attach(accA.id, tagA.id)).rejects.toThrow();
  });
});

describe("cascade / move 清空", () => {
  it("删 Tag → 其 account_tags 行经 cascade 清", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "长线" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(1);
    await tagsOf(USER_A).remove(tag.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(0);
    expect(await tagsOf(USER_A).list()).toHaveLength(0);
  });

  it("删账户 → 其 account_tags 行经 cascade 清", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "长线" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    await accounts(USER_A).remove(acc.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(0);
    expect(await tagsOf(USER_A).list()).toHaveLength(1); // Tag 本身还在
  });

  it("账户 move 到别的 Portfolio → 其 Tag 被清空(ADR 0034 不变量)", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: def.id, name: "长线" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await portfolios(USER_A).assignAccount(acc.id, watch.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(0); // 搬家清空
    expect(await tagsOf(USER_A).list()).toHaveLength(1); // Tag 本身仍在原 Portfolio
  });

  it("重新指到**当前所在** Portfolio(未真搬家)→ Tag 保留,不误清", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: def.id, name: "长线" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    // 目标 == 当前 → no-op,不该触发「搬家清 Tag」。
    await portfolios(USER_A).assignAccount(acc.id, def.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(1);
  });
});

describe("跨用户隔离", () => {
  it("listTagsByUser / listAccountTagsByUser 只返回本人的", async () => {
    const pfA = await portfolios(USER_A).ensureDefault();
    const pfB = await portfolios(USER_B).ensureDefault();
    const accA = await makeAccount(USER_A);
    const tagA = await tagsOf(USER_A).create({ portfolioId: pfA.id, name: "长线" });
    await tagsOf(USER_A).attach(accA.id, tagA.id);
    await tagsOf(USER_B).create({ portfolioId: pfB.id, name: "长线" });
    expect(await tagsOf(USER_A).list()).toHaveLength(1);
    expect(await tagsOf(USER_B).list()).toHaveLength(1);
    expect(await tagsOf(USER_B).listAccountLinks()).toHaveLength(0);
  });
});
