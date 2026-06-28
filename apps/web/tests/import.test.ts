import { describe, expect, it } from "vitest";
import { EXPORT_VERSION } from "../src/lib/export";
import { createImporter, type ImportDeps, ImportError, parseImportLine } from "../src/lib/import";

// 按 type 分类输入字段(模拟 provider.inputs:CEX apiKey=semi + secret/passphrase=secret;链上 identifier=public)。
function categorize(type: string): {
  publicKeys: string[];
  semiKeys: string[];
  secretKeys: string[];
} {
  if (type.startsWith("exchange_"))
    return {
      publicKeys: [],
      semiKeys: ["apiKey"],
      secretKeys: type === "exchange_okx" ? ["secret", "passphrase"] : ["secret"],
    };
  if (type.startsWith("onchain_") || type.startsWith("perp_"))
    return { publicKeys: ["identifier"], semiKeys: [], secretKeys: [] };
  return { publicKeys: [], semiKeys: [], secretKeys: [] }; // manual
}

function makeDeps() {
  const calls = {
    accounts: [] as Array<{ type: string; label: string; creds: string }>,
    groups: [] as Array<{ name: string }>,
    memberships: [] as Array<{ accountId: string; groupId: string }>,
    snapshots: [] as Array<{ accountId: string; totalUsd: number }>,
  };
  let n = 0;
  const deps: ImportDeps = {
    categorize,
    createAccount: async (input) => {
      calls.accounts.push({ type: input.type, label: input.label, creds: input.creds });
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

  it("CEX semi field → stored as semi_<key> placeholder (masked,待补录)", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({
      type: "account",
      id: "x",
      accountType: "exchange_okx",
      label: "OKX",
      creds: { apiKey: "ABCD…5678" }, // 导出已打码的 semi 片段
    });
    // semi → semi_apiKey 占位;secret 文件里没有 → 不写。
    expect(JSON.parse(calls.accounts[0].creds)).toEqual({ semi_apiKey: "ABCD…5678" });
  });

  it("onchain public field → stored whole (reconstructable)", async () => {
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
    expect(JSON.parse(calls.accounts[0].creds)).toEqual({ identifier: "0xabc" });
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

    expect(calls.memberships[0]).toEqual({ accountId: "acc-1", groupId: "grp-2" });
    expect(calls.snapshots[0]).toEqual({ accountId: "acc-1", totalUsd: 42 });
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
