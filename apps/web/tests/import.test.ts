import { describe, expect, it } from "vitest";
import { EXPORT_VERSION } from "../src/lib/export";
import { createImporter, type ImportDeps, ImportError, parseImportLine } from "../src/lib/import";

// 按 connectorId 分类输入字段(模拟 provider account.creds:CEX apiKey=semi + secret/passphrase=secret;
// 链上/perp address=public、bitcoin addressOrXpub=public)。
const ONCHAIN_ADDRESS = new Set(["evm", "solana", "sui", "cosmos", "hyperliquid"]);
function categorize(connectorId: string): {
  publicKeys: string[];
  semiKeys: string[];
  secretKeys: string[];
} {
  if (connectorId === "binance" || connectorId === "okx")
    return {
      publicKeys: [],
      semiKeys: ["apiKey"],
      secretKeys: connectorId === "okx" ? ["secret", "passphrase"] : ["secret"],
    };
  if (connectorId === "bitcoin")
    return { publicKeys: ["addressOrXpub"], semiKeys: [], secretKeys: [] };
  if (ONCHAIN_ADDRESS.has(connectorId))
    return { publicKeys: ["address"], semiKeys: [], secretKeys: [] };
  return { publicKeys: [], semiKeys: [], secretKeys: [] }; // manual
}

function makeDeps() {
  const calls = {
    tokens: [] as Array<{ symbol: string; refs: { namer: string; localName: string }[] }>,
    accounts: [] as Array<{
      connectorId: string;
      label: string;
      creds: string;
      archivedAt?: number | null;
    }>,
    groups: [] as Array<{ name: string }>,
    memberships: [] as Array<{ accountId: string; groupId: string }>,
    snapshots: [] as Array<{ accountId: string; totalUsd: number; balances: unknown[] }>,
    activities: [] as Array<{ accountId: string; tokenId: string; amount: number }>,
  };
  let n = 0;
  const deps: ImportDeps = {
    categorize,
    importToken: async (t, refs) => {
      calls.tokens.push({ symbol: t.symbol, refs });
      return { id: `tk-${++n}` };
    },
    importAccount: async (input) => {
      calls.accounts.push({
        connectorId: input.connectorId,
        label: input.label,
        creds: input.creds,
        archivedAt: input.archivedAt,
      });
      return { id: `acc-${++n}` };
    },
    importGroup: async (input) => {
      calls.groups.push({ name: input.name });
      return { id: `grp-${++n}` };
    },
    addAccountToGroup: async (accountId, groupId) => {
      calls.memberships.push({ accountId, groupId });
    },
    importSnapshot: async (accountId, input) => {
      calls.snapshots.push({ accountId, totalUsd: input.totalUsd, balances: input.balances });
    },
    importManualActivity: async (accountId, tokenId, input) => {
      calls.activities.push({ accountId, tokenId, amount: input.amount });
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

describe("createImporter —— 版本闸", () => {
  it("缺 meta 头 → 报错", async () => {
    const { deps } = makeDeps();
    const imp = createImporter(deps);
    await expect(imp.apply({ type: "account", connectorId: "manual" })).rejects.toThrow(
      ImportError,
    );
  });

  it("旧版本文件(v2)→ 明确报「太旧」,不崩", async () => {
    const { deps } = makeDeps();
    const imp = createImporter(deps);
    await expect(imp.apply({ type: "meta", version: 2 })).rejects.toThrow(/太旧|v2/);
  });

  it("未来版本 → 也拒绝", async () => {
    const { deps } = makeDeps();
    const imp = createImporter(deps);
    await expect(imp.apply({ type: "meta", version: 999 })).rejects.toThrow(ImportError);
  });
});

describe("createImporter —— creds 重建", () => {
  it("CEX semi field → stored as semi_<key> placeholder(masked,待补录)", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({
      type: "account",
      id: "x",
      connectorId: "okx",
      label: "OKX",
      creds: { apiKey: "ABCD…5678" },
    });
    expect(JSON.parse(calls.accounts[0]!.creds)).toEqual({ semi_apiKey: "ABCD…5678" });
  });

  it("onchain public field → stored whole(可重建)", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({
      type: "account",
      id: "x",
      connectorId: "evm",
      label: "W",
      creds: { address: "0xabc" },
    });
    expect(JSON.parse(calls.accounts[0]!.creds)).toEqual({ address: "0xabc" });
    expect(calls.accounts[0]!.archivedAt).toBeUndefined(); // 无 archivedAt → 不归档
  });

  it("带 archivedAt 的账户 → 归档态透传给 importAccount(恢复归档)", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({
      type: "account",
      id: "x",
      connectorId: "evm",
      label: "W",
      creds: { address: "0xabc" },
      archivedAt: 1700000000000,
    });
    expect(calls.accounts[0]!.archivedAt).toBe(1700000000000);
  });
});

describe("createImporter —— Token / 快照 / 活动 的 id 重映射", () => {
  it("token 记录 → importToken(带 ref),建 tokenMap", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({
      type: "token",
      id: "old-tk",
      symbol: "USDC",
      name: "USD Coin",
      refs: [{ namer: "coingecko", localName: "issued:usd-coin" }],
    });
    expect(calls.tokens[0]).toEqual({
      symbol: "USDC",
      refs: [{ namer: "coingecko", localName: "issued:usd-coin" }],
    });
    expect(imp.counts.tokens).toBe(1);
  });

  it("快照余额的 token_id 经 tokenMap 重映射;映射不到的行丢弃", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({ type: "token", id: "old-tk", symbol: "BTC", name: "Bitcoin", refs: [] });
    await imp.apply({ type: "account", id: "old-a", connectorId: "evm", label: "W", creds: {} });
    await imp.apply({
      type: "snapshot",
      accountId: "old-a",
      takenAt: 1000,
      totalUsd: 100,
      balances: [
        { tokenId: "old-tk", amount: 1, usdValue: 100, kind: "spot" },
        { tokenId: "ghost-tk", amount: 5, usdValue: 5, kind: "spot" }, // 映射不到 → 丢
      ],
    });
    const snap = calls.snapshots[0]!;
    expect(snap.accountId).toBe("acc-2"); // token 先建(n=1),account 后建(n=2)
    expect(snap.balances).toHaveLength(1);
    expect(snap.balances[0]).toMatchObject({ tokenId: "tk-1", amount: 1 }); // 重映射到新 token id
  });

  it("活动记录 → recordManualActivity(accountId/tokenId 各自重映射);未知 id 跳过", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({ type: "token", id: "old-tk", symbol: "BTC", name: "Bitcoin", refs: [] });
    await imp.apply({ type: "account", id: "old-a", connectorId: "manual", label: "M", creds: {} });
    await imp.apply({
      type: "manualActivity",
      accountId: "old-a",
      tokenId: "old-tk",
      kind: "add",
      amount: 2,
      occurredAt: 1000,
      createdAt: 5,
    });
    // 未知 token → 跳过
    await imp.apply({
      type: "manualActivity",
      accountId: "old-a",
      tokenId: "ghost",
      kind: "add",
      amount: 9,
      occurredAt: 1,
    });
    expect(calls.activities).toEqual([{ accountId: "acc-2", tokenId: "tk-1", amount: 2 }]);
    expect(imp.counts.activities).toBe(1);
  });

  it("remaps account/group ids for memberships;未知 id 跳过", async () => {
    const { deps, calls } = makeDeps();
    const imp = createImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({ type: "account", id: "old-a", connectorId: "manual", label: "M", creds: {} });
    await imp.apply({ type: "group", id: "old-g", name: "G" });
    await imp.apply({ type: "membership", accountId: "old-a", groupId: "old-g" });
    await imp.apply({ type: "membership", accountId: "ghost", groupId: "ghost" }); // 跳过
    expect(calls.memberships).toEqual([{ accountId: "acc-1", groupId: "grp-2" }]);
  });
});
