import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAccountToGroup,
  createAccount,
  createGroup,
  deleteAccount,
  deleteGroup,
  getAccountById,
  getEncryptedCredentials,
  getLatestSnapshotByUser,
  listAccountsByGroup,
  listAccountsByUser,
  listGroupsByAccount,
  listGroupsByUser,
  listSnapshotsByAccount,
  listSnapshotTotalsByUser,
  removeAccountFromGroup,
  writeSnapshot,
} from "../src";
// 测试可用包内私有句柄:userId→user 外键已启用,业务行需先有 user 行。
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";

const USER_A = "user-a";
const USER_B = "user-b";

// pool-workers 此版本不隔离每个测试的存储。每个测试前重置:删 user 行(级联清掉其
// accounts/groups/snapshots/...),再插入干净的 user 行(满足业务表的 userId 外键)。
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

describe("accounts", () => {
  it("creates, lists, gets, and deletes an account (safe shape, no ciphertext)", async () => {
    const acc = await createAccount(env, USER_A, {
      type: "manual",
      label: "Cash",
      encCredentials: "cipher",
    });
    expect(acc.id).toBeTruthy();
    expect(Object.keys(acc)).not.toContain("encCredentials");

    const list = await listAccountsByUser(env, USER_A);
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("Cash");

    const got = await getAccountById(env, USER_A, acc.id);
    expect(got?.type).toBe("manual");
    expect(Object.keys(got!)).not.toContain("encCredentials");

    await deleteAccount(env, USER_A, acc.id);
    expect(await listAccountsByUser(env, USER_A)).toHaveLength(0);
  });

  it("returns the opaque ciphertext only via the internal getter", async () => {
    const acc = await createAccount(env, USER_A, {
      type: "exchange_binance",
      label: "Binance",
      encCredentials: "ENC-BLOB",
    });
    expect(await getEncryptedCredentials(env, USER_A, acc.id)).toBe("ENC-BLOB");
  });
});

describe("groups & many-to-many membership", () => {
  it("adds/removes membership idempotently and queries both directions", async () => {
    const acc = await createAccount(env, USER_A, {
      type: "manual",
      label: "A",
      encCredentials: "x",
    });
    const g1 = await createGroup(env, USER_A, { name: "G1" });
    const g2 = await createGroup(env, USER_A, { name: "G2", sortOrder: 1 });

    await addAccountToGroup(env, USER_A, acc.id, g1.id);
    await addAccountToGroup(env, USER_A, acc.id, g2.id);
    await addAccountToGroup(env, USER_A, acc.id, g2.id); // idempotent

    expect(await listGroupsByAccount(env, USER_A, acc.id)).toHaveLength(2);
    expect(await listAccountsByGroup(env, USER_A, g1.id)).toHaveLength(1);

    await removeAccountFromGroup(env, USER_A, acc.id, g1.id);
    expect(await listGroupsByAccount(env, USER_A, acc.id)).toHaveLength(1);
  });

  it("deleteGroup removes only the pairings, keeps the account", async () => {
    const acc = await createAccount(env, USER_A, {
      type: "manual",
      label: "A",
      encCredentials: "x",
    });
    const g = await createGroup(env, USER_A, { name: "G" });
    await addAccountToGroup(env, USER_A, acc.id, g.id);

    await deleteGroup(env, USER_A, g.id);
    expect(await listGroupsByUser(env, USER_A)).toHaveLength(0);
    expect(await listAccountsByUser(env, USER_A)).toHaveLength(1);
  });
});

describe("snapshots", () => {
  it("writes snapshot + balances atomically and reads them back", async () => {
    const acc = await createAccount(env, USER_A, {
      type: "manual",
      label: "A",
      encCredentials: "x",
    });
    const id = await writeSnapshot(env, USER_A, acc.id, {
      takenAt: 1000,
      totalUsd: 150,
      balances: [
        { symbol: "BTC", amount: 0.001, usdValue: 100, kind: "spot", source: "manual" },
        {
          symbol: "ETH",
          amount: 0.02,
          usdValue: 50,
          kind: "spot",
          source: "manual",
          meta: { note: "x" },
        },
      ],
    });
    expect(id).toBeTruthy();

    const snaps = await listSnapshotsByAccount(env, USER_A, acc.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.totalUsd).toBe(150);

    const latest = await getLatestSnapshotByUser(env, USER_A);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.balances).toHaveLength(2);
    expect(latest[0]!.balances.find((b) => b.symbol === "ETH")!.metaJson).toContain("note");
  });

  it("writes many balances by chunking under D1's bound-parameter limit", async () => {
    const acc = await createAccount(env, USER_A, {
      type: "onchain_evm",
      label: "Big wallet",
      encCredentials: "x",
    });
    // 60 条余额 × 8 列 = 480 绑定参数,远超 D1 单条 100 上限 → 必须分块,否则 "too many SQL variables"。
    const balances = Array.from({ length: 60 }, (_, i) => ({
      symbol: `T${i}`,
      amount: i,
      usdValue: i * 2,
      kind: "spot" as const,
      source: "ethereum",
    }));
    await writeSnapshot(env, USER_A, acc.id, { takenAt: 1, totalUsd: 100, balances });

    const latest = await getLatestSnapshotByUser(env, USER_A);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.balances).toHaveLength(60); // 全部分块写入、无丢失
  });

  it("returns only the latest snapshot per account, with its balances", async () => {
    const a1 = await createAccount(env, USER_A, {
      type: "manual",
      label: "A1",
      encCredentials: "x",
    });
    const a2 = await createAccount(env, USER_A, {
      type: "manual",
      label: "A2",
      encCredentials: "x",
    });
    // 一个没有快照的账户:不应出现在结果里。
    await createAccount(env, USER_A, { type: "manual", label: "A3", encCredentials: "x" });

    // a1:先旧后新两份快照 → 应只回最新那份(takenAt 2000),余额是 NEW 不是 OLD。
    await writeSnapshot(env, USER_A, a1.id, {
      takenAt: 1000,
      totalUsd: 10,
      balances: [{ symbol: "OLD", amount: 1, usdValue: 10, kind: "spot", source: "s" }],
    });
    await writeSnapshot(env, USER_A, a1.id, {
      takenAt: 2000,
      totalUsd: 20,
      balances: [{ symbol: "NEW", amount: 2, usdValue: 20, kind: "spot", source: "s" }],
    });
    // a2:单份快照。
    await writeSnapshot(env, USER_A, a2.id, {
      takenAt: 1500,
      totalUsd: 5,
      balances: [{ symbol: "ATOM", amount: 5, usdValue: 5, kind: "spot", source: "s" }],
    });

    const latest = await getLatestSnapshotByUser(env, USER_A);
    expect(latest).toHaveLength(2); // a3 无快照 → 不计

    const byAcc = new Map(latest.map((r) => [r.snapshot.accountId, r]));
    const r1 = byAcc.get(a1.id)!;
    expect(r1.snapshot.takenAt).toBe(2000);
    expect(r1.snapshot.totalUsd).toBe(20);
    expect(r1.balances).toHaveLength(1);
    expect(r1.balances[0]!.symbol).toBe("NEW"); // 旧快照的 OLD 不应混入

    const r2 = byAcc.get(a2.id)!;
    expect(r2.snapshot.takenAt).toBe(1500);
    expect(r2.balances[0]!.symbol).toBe("ATOM");
  });

  it("returns [] for a user with no snapshots", async () => {
    await createAccount(env, USER_A, { type: "manual", label: "A", encCredentials: "x" });
    expect(await getLatestSnapshotByUser(env, USER_A)).toEqual([]);
  });

  it("cascades snapshots and pairings when the account is deleted", async () => {
    const acc = await createAccount(env, USER_A, {
      type: "manual",
      label: "A",
      encCredentials: "x",
    });
    const g = await createGroup(env, USER_A, { name: "G" });
    await addAccountToGroup(env, USER_A, acc.id, g.id);
    await writeSnapshot(env, USER_A, acc.id, {
      takenAt: 1,
      totalUsd: 1,
      balances: [{ symbol: "X", amount: 1, usdValue: 1, kind: "spot", source: "s" }],
    });

    await deleteAccount(env, USER_A, acc.id);
    expect(await listGroupsByUser(env, USER_A)).toHaveLength(1); // group kept
    expect(await listAccountsByGroup(env, USER_A, g.id)).toHaveLength(0); // pairing gone
    expect(await getLatestSnapshotByUser(env, USER_A)).toHaveLength(0); // snapshots gone
  });

  it("lists all snapshot totals for a user, ascending by takenAt, scoped to the user", async () => {
    const a1 = await createAccount(env, USER_A, {
      type: "manual",
      label: "A1",
      encCredentials: "x",
    });
    const a2 = await createAccount(env, USER_A, {
      type: "manual",
      label: "A2",
      encCredentials: "x",
    });
    const b1 = await createAccount(env, USER_B, {
      type: "manual",
      label: "B1",
      encCredentials: "x",
    });
    // 跨账户、错时写入(乱序),验证升序返回。
    await writeSnapshot(env, USER_A, a1.id, { takenAt: 2000, totalUsd: 20, balances: [] });
    await writeSnapshot(env, USER_A, a1.id, { takenAt: 1000, totalUsd: 10, balances: [] });
    await writeSnapshot(env, USER_A, a2.id, { takenAt: 1500, totalUsd: 5, balances: [] });
    await writeSnapshot(env, USER_B, b1.id, { takenAt: 1200, totalUsd: 999, balances: [] });

    const totals = await listSnapshotTotalsByUser(env, USER_A);
    expect(totals.map((t) => t.takenAt)).toEqual([1000, 1500, 2000]); // 升序、不含 user B
    expect(totals.map((t) => t.totalUsd)).toEqual([10, 5, 20]);
    expect(totals.find((t) => t.accountId === b1.id)).toBeUndefined();
  });

  it("returns [] of totals for a user with no snapshots", async () => {
    await createAccount(env, USER_A, { type: "manual", label: "A", encCredentials: "x" });
    expect(await listSnapshotTotalsByUser(env, USER_A)).toEqual([]);
  });
});

describe("cross-user isolation", () => {
  it("never leaks another user's data", async () => {
    const a = await createAccount(env, USER_A, { type: "manual", label: "A", encCredentials: "x" });
    await createGroup(env, USER_A, { name: "GA" });
    await writeSnapshot(env, USER_A, a.id, { takenAt: 1, totalUsd: 1, balances: [] });

    expect(await listAccountsByUser(env, USER_B)).toHaveLength(0);
    expect(await listGroupsByUser(env, USER_B)).toHaveLength(0);
    expect(await getAccountById(env, USER_B, a.id)).toBeNull();
    expect(await getEncryptedCredentials(env, USER_B, a.id)).toBeNull();

    await expect(listSnapshotsByAccount(env, USER_B, a.id)).rejects.toThrow();
    await expect(
      writeSnapshot(env, USER_B, a.id, { takenAt: 2, totalUsd: 2, balances: [] }),
    ).rejects.toThrow();
    await expect(addAccountToGroup(env, USER_B, a.id, "nope")).rejects.toThrow();
  });
});
