import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
// 测试可用包内私有句柄:userId→user 外键已启用,业务行需先有 user 行。
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";
import {
  addAccountToGroup,
  createAccount,
  createGroup,
  deleteAccount,
  deleteGroup,
  getAccountById,
  getLatestSnapshotByUser,
  getRawCreds,
  listAccountsByGroup,
  listAccountsByUser,
  listBalancesForSnapshots,
  listGroupsByAccount,
  listGroupsByUser,
  listMembershipsByUser,
  listRawCredsByUser,
  listSnapshotsByAccount,
  listSnapshotsPageByUser,
  listSnapshotTotalsByUser,
  listUserIdsWithAccounts,
  removeAccountFromGroup,
  renameAccount,
  setAccountCredentials,
  setArchived,
  writeSnapshot,
} from "../src/queries"; // 包内测试白盒:公开面只出 createDb 门面(见 encapsulation.test)

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
      connectorId: "manual",
      label: "Cash",
      creds: "cipher",
    });
    expect(acc.id).toBeTruthy();
    expect(Object.keys(acc)).not.toContain("encCredentials");

    const list = await listAccountsByUser(env, USER_A);
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("Cash");

    const got = await getAccountById(env, USER_A, acc.id);
    expect(got?.connectorId).toBe("manual");
    expect(Object.keys(got!)).not.toContain("encCredentials");

    await deleteAccount(env, USER_A, acc.id);
    expect(await listAccountsByUser(env, USER_A)).toHaveLength(0);
  });

  it("returns the opaque creds map only via the internal getter", async () => {
    const acc = await createAccount(env, USER_A, {
      connectorId: "binance",
      label: "Binance",
      creds: '{"apiKey":"K","secret":"<enc>"}',
    });
    expect(await getRawCreds(env, USER_A, acc.id)).toBe('{"apiKey":"K","secret":"<enc>"}');
  });

  it("listUserIdsWithAccounts returns distinct user ids that own accounts (cron sweep)", async () => {
    expect(await listUserIdsWithAccounts(env)).toEqual([]); // 无账户
    await createAccount(env, USER_A, { connectorId: "manual", label: "A1", creds: "x" });
    await createAccount(env, USER_A, { connectorId: "manual", label: "A2", creds: "x" }); // 同用户两账户 → 去重
    await createAccount(env, USER_B, { connectorId: "manual", label: "B1", creds: "x" });
    const ids = await listUserIdsWithAccounts(env);
    expect([...ids].sort()).toEqual([USER_A, USER_B].sort());
  });

  it("round-trips the creds map (incl. semi_ placeholder) and rehydrates via setAccountCredentials", async () => {
    // 导入的缺凭据 CEX:creds 只含 semi 打码占位(无真 apiKey/secret)。
    const imported = JSON.stringify({ semi_apiKey: "ABCD…5678" });
    const acc = await createAccount(env, USER_A, {
      connectorId: "okx",
      label: "Imported OKX",
      creds: imported,
    });
    expect(await getRawCreds(env, USER_A, acc.id)).toBe(imported);
    // creds 不进安全形状(含 secret 密文)。
    const got = await getAccountById(env, USER_A, acc.id);
    expect(Object.keys(got!)).not.toContain("creds");

    // 补录:整张 map 覆盖。
    const sealed = JSON.stringify({ apiKey: "REAL", secret: "<enc>", passphrase: "<enc>" });
    await setAccountCredentials(env, USER_A, acc.id, sealed);
    expect(await getRawCreds(env, USER_A, acc.id)).toBe(sealed);
  });

  it("renameAccount changes the label (user-scoped)", async () => {
    const acc = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "Old",
      creds: "x",
    });
    await renameAccount(env, USER_A, acc.id, "New");
    expect((await getAccountById(env, USER_A, acc.id))?.label).toBe("New");
    // 越权:另一用户改不动。
    await renameAccount(env, USER_B, acc.id, "Hacked");
    expect((await getAccountById(env, USER_A, acc.id))?.label).toBe("New");
  });

  it("setArchived toggles archivedAt (reversible, user-scoped)", async () => {
    const acc = await createAccount(env, USER_A, { connectorId: "manual", label: "M", creds: "x" });
    expect((await getAccountById(env, USER_A, acc.id))?.archivedAt).toBeNull();
    await setArchived(env, USER_A, acc.id, true);
    expect((await getAccountById(env, USER_A, acc.id))?.archivedAt).toBeGreaterThan(0);
    await setArchived(env, USER_A, acc.id, false);
    expect((await getAccountById(env, USER_A, acc.id))?.archivedAt).toBeNull();
  });

  it("listRawCredsByUser returns each account's raw creds (user-scoped; for safeView 富化)", async () => {
    const a1 = await createAccount(env, USER_A, { connectorId: "manual", label: "M", creds: "{}" });
    const a2 = await createAccount(env, USER_A, {
      connectorId: "evm",
      label: "W",
      creds: '{"identifier":"0xabc"}',
    });
    await createAccount(env, USER_B, { connectorId: "manual", label: "B", creds: "{}" });
    const rows = await listRawCredsByUser(env, USER_A);
    expect(new Map(rows.map((r) => [r.id, r.creds]))).toEqual(
      new Map([
        [a1.id, "{}"],
        [a2.id, '{"identifier":"0xabc"}'],
      ]),
    );
  });
});

describe("groups & many-to-many membership", () => {
  it("adds/removes membership idempotently and queries both directions", async () => {
    const acc = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A",
      creds: "x",
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
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const g = await createGroup(env, USER_A, { name: "G" });
    await addAccountToGroup(env, USER_A, acc.id, g.id);

    await deleteGroup(env, USER_A, g.id);
    expect(await listGroupsByUser(env, USER_A)).toHaveLength(0);
    expect(await listAccountsByUser(env, USER_A)).toHaveLength(1);
  });

  it("lists all memberships for a user in one query, scoped to the user", async () => {
    const a1 = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A1",
      creds: "x",
    });
    const a2 = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A2",
      creds: "x",
    });
    const g1 = await createGroup(env, USER_A, { name: "G1" });
    const g2 = await createGroup(env, USER_A, { name: "G2" });
    await addAccountToGroup(env, USER_A, a1.id, g1.id);
    await addAccountToGroup(env, USER_A, a1.id, g2.id); // a1 在两个组
    await addAccountToGroup(env, USER_A, a2.id, g1.id);
    // user B 自有关联,不应混入。
    const b1 = await createAccount(env, USER_B, {
      connectorId: "manual",
      label: "B1",
      creds: "x",
    });
    const gb = await createGroup(env, USER_B, { name: "GB" });
    await addAccountToGroup(env, USER_B, b1.id, gb.id);

    const ms = await listMembershipsByUser(env, USER_A);
    expect(ms).toHaveLength(3);
    expect(
      ms
        .filter((m) => m.accountId === a1.id)
        .map((m) => m.groupId)
        .sort(),
    ).toEqual([g1.id, g2.id].sort());
    expect(ms.find((m) => m.accountId === b1.id)).toBeUndefined();
  });

  it("returns [] memberships for a user with none", async () => {
    await createAccount(env, USER_A, { connectorId: "manual", label: "A", creds: "x" });
    expect(await listMembershipsByUser(env, USER_A)).toEqual([]);
  });
});

describe("snapshots", () => {
  it("writes snapshot + balances atomically and reads them back", async () => {
    const acc = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const id = await writeSnapshot(env, USER_A, acc.id, {
      takenAt: 1000,
      totalUsd: 150,
      balances: [
        { symbol: "BTC", amount: 0.001, usdValue: 100, kind: "spot" },
        {
          symbol: "ETH",
          amount: 0.02,
          usdValue: 50,
          kind: "spot",
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
      connectorId: "evm",
      label: "Big wallet",
      creds: "x",
    });
    // 60 条余额 × 9 列 = 540 绑定参数,远超 D1 单条 100 上限 → 必须分块,否则 "too many SQL variables"。
    const balances = Array.from({ length: 60 }, (_, i) => ({
      symbol: `T${i}`,
      amount: i,
      usdValue: i * 2,
      kind: "spot" as const,
    }));
    await writeSnapshot(env, USER_A, acc.id, { takenAt: 1, totalUsd: 100, balances });

    const latest = await getLatestSnapshotByUser(env, USER_A);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.balances).toHaveLength(60); // 全部分块写入、无丢失
  });

  it("returns only the latest snapshot per account, with its balances", async () => {
    const a1 = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A1",
      creds: "x",
    });
    const a2 = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A2",
      creds: "x",
    });
    // 一个没有快照的账户:不应出现在结果里。
    await createAccount(env, USER_A, { connectorId: "manual", label: "A3", creds: "x" });

    // a1:先旧后新两份快照 → 应只回最新那份(takenAt 2000),余额是 NEW 不是 OLD。
    await writeSnapshot(env, USER_A, a1.id, {
      takenAt: 1000,
      totalUsd: 10,
      balances: [{ symbol: "OLD", amount: 1, usdValue: 10, kind: "spot" }],
    });
    await writeSnapshot(env, USER_A, a1.id, {
      takenAt: 2000,
      totalUsd: 20,
      balances: [{ symbol: "NEW", amount: 2, usdValue: 20, kind: "spot" }],
    });
    // a2:单份快照。
    await writeSnapshot(env, USER_A, a2.id, {
      takenAt: 1500,
      totalUsd: 5,
      balances: [{ symbol: "ATOM", amount: 5, usdValue: 5, kind: "spot" }],
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
    await createAccount(env, USER_A, { connectorId: "manual", label: "A", creds: "x" });
    expect(await getLatestSnapshotByUser(env, USER_A)).toEqual([]);
  });

  it("cascades snapshots and pairings when the account is deleted", async () => {
    const acc = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const g = await createGroup(env, USER_A, { name: "G" });
    await addAccountToGroup(env, USER_A, acc.id, g.id);
    await writeSnapshot(env, USER_A, acc.id, {
      takenAt: 1,
      totalUsd: 1,
      balances: [{ symbol: "X", amount: 1, usdValue: 1, kind: "spot" }],
    });

    await deleteAccount(env, USER_A, acc.id);
    expect(await listGroupsByUser(env, USER_A)).toHaveLength(1); // group kept
    expect(await listAccountsByGroup(env, USER_A, g.id)).toHaveLength(0); // pairing gone
    expect(await getLatestSnapshotByUser(env, USER_A)).toHaveLength(0); // snapshots gone
  });

  it("lists all snapshot totals for a user, ascending by takenAt, scoped to the user", async () => {
    const a1 = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A1",
      creds: "x",
    });
    const a2 = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "A2",
      creds: "x",
    });
    const b1 = await createAccount(env, USER_B, {
      connectorId: "manual",
      label: "B1",
      creds: "x",
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
    await createAccount(env, USER_A, { connectorId: "manual", label: "A", creds: "x" });
    expect(await listSnapshotTotalsByUser(env, USER_A)).toEqual([]);
  });

  it("paginates snapshots (asc takenAt) and fetches balances by id (export)", async () => {
    const a = await createAccount(env, USER_A, { connectorId: "manual", label: "A", creds: "x" });
    const b1 = await createAccount(env, USER_B, {
      connectorId: "manual",
      label: "B",
      creds: "x",
    });
    for (const t of [3000, 1000, 2000]) {
      await writeSnapshot(env, USER_A, a.id, {
        takenAt: t,
        totalUsd: t,
        balances: [{ symbol: `S${t}`, amount: 1, usdValue: t, kind: "spot" }],
      });
    }
    await writeSnapshot(env, USER_B, b1.id, { takenAt: 9, totalUsd: 9, balances: [] });

    const page1 = await listSnapshotsPageByUser(env, USER_A, 2, 0);
    const page2 = await listSnapshotsPageByUser(env, USER_A, 2, 2);
    expect(page1.map((s) => s.takenAt)).toEqual([1000, 2000]); // asc, user A only
    expect(page2.map((s) => s.takenAt)).toEqual([3000]);
    expect(page2[0]!.accountId).toBe(a.id); // 不含 user B

    const bal = await listBalancesForSnapshots(
      env,
      page1.map((s) => s.id),
    );
    expect(bal).toHaveLength(2);
    expect(await listBalancesForSnapshots(env, [])).toEqual([]);
  });
});

describe("cross-user isolation", () => {
  it("never leaks another user's data", async () => {
    const a = await createAccount(env, USER_A, { connectorId: "manual", label: "A", creds: "x" });
    await createGroup(env, USER_A, { name: "GA" });
    await writeSnapshot(env, USER_A, a.id, { takenAt: 1, totalUsd: 1, balances: [] });

    expect(await listAccountsByUser(env, USER_B)).toHaveLength(0);
    expect(await listGroupsByUser(env, USER_B)).toHaveLength(0);
    expect(await getAccountById(env, USER_B, a.id)).toBeNull();
    expect(await getRawCreds(env, USER_B, a.id)).toBeNull();

    await expect(listSnapshotsByAccount(env, USER_B, a.id)).rejects.toThrow();
    await expect(
      writeSnapshot(env, USER_B, a.id, { takenAt: 2, totalUsd: 2, balances: [] }),
    ).rejects.toThrow();
    await expect(addAccountToGroup(env, USER_B, a.id, "nope")).rejects.toThrow();
  });
});
