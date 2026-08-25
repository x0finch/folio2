import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

const transferOf = forDomain((db) => db.transfer);

const accounts = forDomain((db) => db.accounts);
const portfolios = forDomain((db) => db.portfolios);

// Portfolio 地基(ADR 0033)对着真 D1 跑:唯一约束 / 部分索引 / cascade / batch 都真生效。
// 不隔离每测存储 → beforeEach 重置用户(级联清 portfolios/portfolio_accounts)。

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

describe("ensureDefaultPortfolio", () => {
  it("find-or-create:同用户反复调 → 同一行(幂等)", async () => {
    const p1 = await portfolios(USER_A).ensureDefault();
    const p2 = await portfolios(USER_A).ensureDefault();
    expect(p2.id).toBe(p1.id);
    expect(p1.isDefault).toBe(true);
    expect(await portfolios(USER_A).list()).toHaveLength(1);
  });

  it("名字 = `<用户名>'s`", async () => {
    await resetUser(USER_A, "Alice");
    const p = await portfolios(USER_A).ensureDefault();
    expect(p.name).toBe("Alice's");
  });

  it("用户名为空 → 兜底 `My Portfolio`", async () => {
    await resetUser(USER_A, "");
    const p = await portfolios(USER_A).ensureDefault();
    expect(p.name).toBe("My Portfolio");
  });

  it("部分唯一索引:一个用户只能有一个默认 Portfolio", async () => {
    const p = await portfolios(USER_A).ensureDefault();
    // 手动插第二个默认 → 撞 portfolios_user_default_uidx。
    await expect(
      env.DB.prepare(
        "INSERT INTO portfolios (id, user_id, name, is_default, sort_order, created_at) VALUES (?, ?, ?, 1, 0, 0)",
      )
        .bind("dup-pf", USER_A, "Dup")
        .run(),
    ).rejects.toThrow();
    expect(p.isDefault).toBe(true);
  });
});

describe("account ↔ portfolio 归属(每账户恰一行)", () => {
  it("createAccount 把新账户落进默认 Portfolio", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const pf = await portfolios(USER_A).ensureDefault();
    const memberships = await portfolios(USER_A).listMemberships();
    expect(memberships).toEqual([{ accountId: acc.id, portfolioId: pf.id }]);
  });

  it("importAccount(新建分支)也归属默认 Portfolio", async () => {
    const { id, created } = await transferOf(USER_A).importAccount({
      connectorId: "manual",
      label: "Imported",
      creds: "x",
    });
    expect(created).toBe(true);
    const pf = await portfolios(USER_A).ensureDefault();
    expect(await portfolios(USER_A).listMemberships()).toEqual([
      { accountId: id, portfolioId: pf.id },
    ]);
  });

  it("importAccount(命中既有)不重复插归属", async () => {
    const first = await transferOf(USER_A).importAccount({
      connectorId: "manual",
      label: "Dup",
      creds: "x",
    });
    const second = await transferOf(USER_A).importAccount({
      connectorId: "manual",
      label: "Dup",
      creds: "x",
    });
    expect(second.id).toBe(first.id);
    expect(await portfolios(USER_A).listMemberships()).toHaveLength(1);
  });

  it("删账户 → 归属行经 cascade 清", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    expect(await portfolios(USER_A).listMemberships()).toHaveLength(1);
    await accounts(USER_A).remove(acc.id);
    expect(await portfolios(USER_A).listMemberships()).toHaveLength(0);
    expect(await accounts(USER_A).list()).toHaveLength(0);
  });

  it("一对一锁:一个账户不能归属两个 Portfolio", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    // 手动再插一行归属(不同 portfolio_id)→ 撞 portfolio_accounts_account_uidx。
    await expect(
      env.DB.prepare("INSERT INTO portfolio_accounts (portfolio_id, account_id) VALUES (?, ?)")
        .bind("other-pf", acc.id)
        .run(),
    ).rejects.toThrow();
  });
});

describe("createPortfolio / assignAccountToPortfolio", () => {
  it("createPortfolio 建的是命名非默认 Portfolio;列表按创建序(不置顶默认)", async () => {
    const def = await portfolios(USER_A).ensureDefault(); // 先建默认
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    expect(watch.isDefault).toBe(false);
    const all = await portfolios(USER_A).list();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.id)).toEqual([def.id, watch.id]); // 创建序:默认先建 → 在前(非因它是默认)
    expect(all.filter((p) => p.isDefault)).toHaveLength(1); // 仍只一个默认
  });

  it("assignAccountToPortfolio 一对一改归属(旧行替换,不叠加)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await portfolios(USER_A).assignAccount(acc.id, watch.id);
    const memberships = await portfolios(USER_A).listMemberships();
    expect(memberships).toEqual([{ accountId: acc.id, portfolioId: watch.id }]); // 仍恰一行,指向 Watch
  });

  it("assignAccountToPortfolio 拒绝越权(他人账户 / 他人 Portfolio)", async () => {
    const accA = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const pfB = await portfolios(USER_B).create({ name: "B's" });
    // A 的账户移到 B 的 Portfolio → 拒。
    await expect(portfolios(USER_A).assignAccount(accA.id, pfB.id)).rejects.toThrow();
    // B 动 A 的账户 → 拒(账户 owner 断言)。
    await expect(portfolios(USER_B).assignAccount(accA.id, pfB.id)).rejects.toThrow();
  });
});

describe("管理:rename / setDefault / delete", () => {
  it("renamePortfolio 改名(含默认)", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    await portfolios(USER_A).rename(def.id, "Renamed");
    const all = await portfolios(USER_A).list();
    expect(all[0]!.name).toBe("Renamed");
  });

  it("setDefaultPortfolio 换默认:恰一个默认,旧默认降级", async () => {
    const old = await portfolios(USER_A).ensureDefault();
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await portfolios(USER_A).setDefault(watch.id);
    const all = await portfolios(USER_A).list();
    expect(all.filter((p) => p.isDefault)).toHaveLength(1);
    expect(all.find((p) => p.id === watch.id)!.isDefault).toBe(true);
    expect(all.find((p) => p.id === old.id)!.isDefault).toBe(false);
  });

  it("deletePortfolio 拒删默认", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    // 类型化失败,不是 defect(#527 裁定 4):陈旧页面发得出这个请求。
    await expect(portfolios(USER_A).remove(def.id)).rejects.toThrow(
      /default portfolio cannot be deleted/,
    );
  });

  it("deletePortfolio 命名组:成员退回默认后删该行(账户不动)", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await portfolios(USER_A).assignAccount(acc.id, watch.id);

    await portfolios(USER_A).remove(watch.id);

    // 组没了、账户还在、归属退回默认。
    expect(await portfolios(USER_A).list()).toHaveLength(1);
    expect(await accounts(USER_A).list()).toHaveLength(1);
    expect(await portfolios(USER_A).listMemberships()).toEqual([
      { accountId: acc.id, portfolioId: def.id },
    ]);
  });

  it("空的命名组也能删(空组持久、只显式删)", async () => {
    await portfolios(USER_A).ensureDefault();
    const empty = await portfolios(USER_A).create({ name: "Empty" });
    await portfolios(USER_A).remove(empty.id);
    expect(await portfolios(USER_A).list()).toHaveLength(1);
  });
});

describe("listPortfolios / memberships 跨用户隔离", () => {
  it("listPortfoliosByUser 只返回本人的", async () => {
    await portfolios(USER_A).ensureDefault();
    await portfolios(USER_B).ensureDefault();
    const a = await portfolios(USER_A).list();
    expect(a).toHaveLength(1);
    expect(a[0]!.isDefault).toBe(true);
    expect(await portfolios(USER_B).list()).toHaveLength(1);
  });

  it("memberships 不泄露他人账户归属", async () => {
    await accounts(USER_A).create({ connectorId: "manual", label: "A", creds: "x" });
    await accounts(USER_B).create({ connectorId: "manual", label: "B", creds: "x" });
    expect(await portfolios(USER_A).listMemberships()).toHaveLength(1);
    expect(await portfolios(USER_B).listMemberships()).toHaveLength(1);
    const aAccts = new Set((await accounts(USER_A).list()).map((x) => x.id));
    for (const m of await portfolios(USER_A).listMemberships()) {
      expect(aAccts.has(m.accountId)).toBe(true);
    }
  });
});
