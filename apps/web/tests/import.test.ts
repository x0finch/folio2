import { describe, expect, it } from "vitest";
import { EXPORT_VERSION } from "../src/lib/export";
import { createImporter, type ImportDeps, ImportError, parseImportLine } from "../src/lib/import";

// 假 deps:记录调用 + 返回递增 id,模拟 secret-input 账户类型(CEX 缺凭据)。
function makeDeps(secretTypes: string[] = ["exchange_okx", "exchange_binance"]) {
  const calls = {
    accounts: [] as Array<{ type: string; label: string; encCredentials: string | null }>,
    groups: [] as Array<{ name: string }>,
    memberships: [] as Array<{ accountId: string; groupId: string }>,
    snapshots: [] as Array<{ accountId: string; totalUsd: number }>,
  };
  let n = 0;
  const deps: ImportDeps = {
    hasSecretInputs: (type) => secretTypes.includes(type),
    encryptCreds: async (creds) => `enc(${JSON.stringify(creds)})`,
    createAccount: async (input) => {
      calls.accounts.push({
        type: input.type,
        label: input.label,
        encCredentials: input.encCredentials,
      });
      return { id: `acc-${++n}` };
    },
    createGroup: async (input) => {
      calls.groups.push({ name: input.name });
      return { id: `grp-${++n}` };
    },
    addAccountToGroup: async (accountId, groupId) => {
      calls.memberships.push({ accountId, groupId });
    },
    writeSnapshot: async (accountId, input) => {
      calls.snapshots.push({ accountId, totalUsd: input.totalUsd });
    },
  };
  return { deps, calls };
}

describe("parseImportLine", () => {
  it("parses a JSON object line; blanks/garbage → null", () => {
    expect(parseImportLine('{"type":"meta"}')).toEqual({ type: "meta" });
    expect(parseImportLine("  ")).toBeNull();
    expect(parseImportLine("not json")).toBeNull();
    expect(parseImportLine("123")).toBeNull(); // 非对象
  });
});

describe("createImporter", () => {
  it("rejects a missing/unsupported meta header", async () => {
    const { deps } = makeDeps();
    const imp = createImporter(deps);
    await expect(imp.apply({ type: "account", accountType: "manual" })).rejects.toThrow(
      ImportError,
    );

    const imp2 = createImporter(deps);
    await expect(imp2.apply({ type: "meta", version: 999 })).rejects.toThrow(ImportError);
  });

  it("CEX account (secret inputs) → encCredentials null (needs credentials)", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({
      type: "account",
      id: "x",
      accountType: "exchange_okx",
      label: "OKX",
      creds: {},
    });
    expect(calls.accounts[0]).toMatchObject({ type: "exchange_okx", encCredentials: null });
  });

  it("non-secret account (onchain) → encrypts exported creds", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({
      type: "account",
      id: "x",
      accountType: "onchain_evm",
      label: "W",
      creds: { identifier: "0xabc" },
    });
    expect(calls.accounts[0].encCredentials).toBe('enc({"identifier":"0xabc"})');
  });

  it("remaps account/group ids for memberships and snapshots", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({ type: "account", id: "old-a", accountType: "manual", label: "M", creds: {} });
    await imp.apply({ type: "group", id: "old-g", name: "G" });
    await imp.apply({ type: "membership", accountId: "old-a", groupId: "old-g" });
    await imp.apply({
      type: "snapshot",
      accountId: "old-a",
      takenAt: 1000,
      totalUsd: 42,
      balances: [],
    });

    const accId = calls.accounts.length ? "acc-1" : "";
    expect(calls.memberships[0]).toEqual({ accountId: accId, groupId: "grp-2" });
    expect(calls.snapshots[0]).toEqual({ accountId: accId, totalUsd: 42 });
    expect(imp.counts).toMatchObject({ accounts: 1, groups: 1, memberships: 1, snapshots: 1 });
  });

  it("skips memberships/snapshots for unknown (unremapped) ids", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({ type: "membership", accountId: "ghost", groupId: "ghost" });
    await imp.apply({
      type: "snapshot",
      accountId: "ghost",
      takenAt: 1,
      totalUsd: 1,
      balances: [],
    });
    expect(calls.memberships).toHaveLength(0);
    expect(calls.snapshots).toHaveLength(0);
  });
});
