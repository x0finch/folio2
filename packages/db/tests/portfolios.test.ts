import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";
import {
  assignAccountToPortfolio,
  createAccount,
  createPortfolio,
  deleteAccount,
  ensureDefaultPortfolio,
  importAccount,
  listAccountsByUser,
  listPortfolioMembershipsByUser,
  listPortfoliosByUser,
} from "../src/queries";

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
    const p1 = await ensureDefaultPortfolio(env, USER_A);
    const p2 = await ensureDefaultPortfolio(env, USER_A);
    expect(p2.id).toBe(p1.id);
    expect(p1.isDefault).toBe(true);
    expect(await listPortfoliosByUser(env, USER_A)).toHaveLength(1);
  });

  it("名字 = `<用户名>'s`", async () => {
    await resetUser(USER_A, "Alice");
    const p = await ensureDefaultPortfolio(env, USER_A);
    expect(p.name).toBe("Alice's");
  });

  it("用户名为空 → 兜底 `My Portfolio`", async () => {
    await resetUser(USER_A, "");
    const p = await ensureDefaultPortfolio(env, USER_A);
    expect(p.name).toBe("My Portfolio");
  });

  it("部分唯一索引:一个用户只能有一个默认 Portfolio", async () => {
    const p = await ensureDefaultPortfolio(env, USER_A);
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
    const acc = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const pf = await ensureDefaultPortfolio(env, USER_A);
    const memberships = await listPortfolioMembershipsByUser(env, USER_A);
    expect(memberships).toEqual([{ accountId: acc.id, portfolioId: pf.id }]);
  });

  it("importAccount(新建分支)也归属默认 Portfolio", async () => {
    const { id, created } = await importAccount(env, USER_A, {
      connectorId: "manual",
      label: "Imported",
      creds: "x",
    });
    expect(created).toBe(true);
    const pf = await ensureDefaultPortfolio(env, USER_A);
    expect(await listPortfolioMembershipsByUser(env, USER_A)).toEqual([
      { accountId: id, portfolioId: pf.id },
    ]);
  });

  it("importAccount(命中既有)不重复插归属", async () => {
    const first = await importAccount(env, USER_A, {
      connectorId: "manual",
      label: "Dup",
      creds: "x",
    });
    const second = await importAccount(env, USER_A, {
      connectorId: "manual",
      label: "Dup",
      creds: "x",
    });
    expect(second.id).toBe(first.id);
    expect(await listPortfolioMembershipsByUser(env, USER_A)).toHaveLength(1);
  });

  it("删账户 → 归属行经 cascade 清", async () => {
    const acc = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    expect(await listPortfolioMembershipsByUser(env, USER_A)).toHaveLength(1);
    await deleteAccount(env, USER_A, acc.id);
    expect(await listPortfolioMembershipsByUser(env, USER_A)).toHaveLength(0);
    expect(await listAccountsByUser(env, USER_A)).toHaveLength(0);
  });

  it("一对一锁:一个账户不能归属两个 Portfolio", async () => {
    const acc = await createAccount(env, USER_A, {
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
  it("createPortfolio 建的是命名非默认 Portfolio(不碰默认唯一索引)", async () => {
    await ensureDefaultPortfolio(env, USER_A); // 已有默认
    const watch = await createPortfolio(env, USER_A, { name: "Watch" });
    expect(watch.isDefault).toBe(false);
    const all = await listPortfoliosByUser(env, USER_A);
    expect(all).toHaveLength(2);
    expect(all[0]!.isDefault).toBe(true); // 默认在前
    expect(all.filter((p) => p.isDefault)).toHaveLength(1); // 仍只一个默认
  });

  it("assignAccountToPortfolio 一对一改归属(旧行替换,不叠加)", async () => {
    const acc = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const watch = await createPortfolio(env, USER_A, { name: "Watch" });
    await assignAccountToPortfolio(env, USER_A, acc.id, watch.id);
    const memberships = await listPortfolioMembershipsByUser(env, USER_A);
    expect(memberships).toEqual([{ accountId: acc.id, portfolioId: watch.id }]); // 仍恰一行,指向 Watch
  });

  it("assignAccountToPortfolio 拒绝越权(他人账户 / 他人 Portfolio)", async () => {
    const accA = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const pfB = await createPortfolio(env, USER_B, { name: "B's" });
    // A 的账户移到 B 的 Portfolio → 拒。
    await expect(assignAccountToPortfolio(env, USER_A, accA.id, pfB.id)).rejects.toThrow();
    // B 动 A 的账户 → 拒(账户 owner 断言)。
    await expect(assignAccountToPortfolio(env, USER_B, accA.id, pfB.id)).rejects.toThrow();
  });
});

describe("listPortfolios / memberships 跨用户隔离", () => {
  it("listPortfoliosByUser 只返回本人的", async () => {
    await ensureDefaultPortfolio(env, USER_A);
    await ensureDefaultPortfolio(env, USER_B);
    const a = await listPortfoliosByUser(env, USER_A);
    expect(a).toHaveLength(1);
    expect(a[0]!.isDefault).toBe(true);
    expect(await listPortfoliosByUser(env, USER_B)).toHaveLength(1);
  });

  it("memberships 不泄露他人账户归属", async () => {
    await createAccount(env, USER_A, { connectorId: "manual", label: "A", creds: "x" });
    await createAccount(env, USER_B, { connectorId: "manual", label: "B", creds: "x" });
    expect(await listPortfolioMembershipsByUser(env, USER_A)).toHaveLength(1);
    expect(await listPortfolioMembershipsByUser(env, USER_B)).toHaveLength(1);
    const aAccts = new Set((await listAccountsByUser(env, USER_A)).map((x) => x.id));
    for (const m of await listPortfolioMembershipsByUser(env, USER_A)) {
      expect(aAccts.has(m.accountId)).toBe(true);
    }
  });
});
