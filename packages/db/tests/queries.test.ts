import { env } from "cloudflare:test";
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
  removeAccountFromGroup,
  writeSnapshot,
} from "../src";

const USER_A = "user-a";
const USER_B = "user-b";

// pool-workers 此版本不隔离每个测试的存储,故每个测试前用公共 API 清空(删账户级联快照/配对)。
async function clearUser(userId: string): Promise<void> {
  for (const a of await listAccountsByUser(env, userId)) await deleteAccount(env, userId, a.id);
  for (const g of await listGroupsByUser(env, userId)) await deleteGroup(env, userId, g.id);
}

beforeEach(async () => {
  await clearUser(USER_A);
  await clearUser(USER_B);
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
