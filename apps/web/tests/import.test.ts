import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { EXPORT_VERSION } from "@/lib/server/io/export";
import {
  createImporter,
  type ImportDeps,
  ImportError,
  parseImportLine,
} from "@/lib/server/io/import";

//
const promisedImporter = (deps: ImportDeps) => {
  const imp = createImporter(deps);
  return {
    counts: imp.counts,
    apply: async (rec: Record<string, unknown>): Promise<void> => {
      const exit = await Effect.runPromiseExit(imp.apply(rec));
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    },
  };
};

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
    snapshots: [] as Array<{ accountId: string; totalUsd: number; balances: unknown[] }>,
    activities: [] as Array<{ accountId: string; tokenId: string; amount: number }>,
  };
  let n = 0;
  const deps: ImportDeps = {
    categorize,
    importToken: (t, refs) =>
      Effect.sync(() => {
        calls.tokens.push({ symbol: t.symbol, refs });
        return { id: `tk-${++n}` };
      }),
    importAccount: (input) =>
      Effect.sync(() => {
        calls.accounts.push({
          connectorId: input.connectorId,
          label: input.label,
          creds: input.creds,
          archivedAt: input.archivedAt,
        });
        return { id: `acc-${++n}` };
      }),
    importSnapshot: (accountId, input) =>
      Effect.sync(() => {
        calls.snapshots.push({ accountId, totalUsd: input.totalUsd, balances: input.balances });
      }),
    importManualActivity: (accountId, tokenId, input) =>
      Effect.sync(() => {
        calls.activities.push({ accountId, tokenId, amount: input.amount });
      }),
  };
  return { deps, calls };
}

describe("parseImportLine", () => {
  it("parses a JSON object line; blanks/garbage → null", () => {
    expect(parseImportLine('{"type":"meta"}')).toEqual({ type: "meta" });
    expect(parseImportLine("  ")).toBeNull();
    expect(parseImportLine("not json")).toBeNull();
    expect(parseImportLine("123")).toBeNull();
  });
});

describe("createImporter: version gate", () => {
  it("missing meta header: errors", async () => {
    const { deps } = makeDeps();
    const imp = promisedImporter(deps);
    await expect(imp.apply({ type: "account", connectorId: "manual" })).rejects.toThrow(
      ImportError,
    );
  });

  it('old-version file (v2): explicitly reports "too old", no crash', async () => {
    const { deps } = makeDeps();
    const imp = promisedImporter(deps);
    await expect(imp.apply({ type: "meta", version: 2 })).rejects.toThrow(/太旧|v2/);
  });

  it("future version: also rejected", async () => {
    const { deps } = makeDeps();
    const imp = promisedImporter(deps);
    await expect(imp.apply({ type: "meta", version: 999 })).rejects.toThrow(ImportError);
  });
});

describe("createImporter: creds rebuild", () => {
  it("CEX semi field: stored as a semi_<key> placeholder (masked, to be re-entered)", async () => {
    const { deps, calls } = makeDeps();
    const imp = promisedImporter(deps);
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

  it("onchain public field: stored whole (rebuildable)", async () => {
    const { deps, calls } = makeDeps();
    const imp = promisedImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({
      type: "account",
      id: "x",
      connectorId: "evm",
      label: "W",
      creds: { address: "0xabc" },
    });
    expect(JSON.parse(calls.accounts[0]!.creds)).toEqual({ address: "0xabc" });
    expect(calls.accounts[0]!.archivedAt).toBeUndefined();
  });

  it("account with archivedAt: archived state passed through to importAccount (archive restored)", async () => {
    const { deps, calls } = makeDeps();
    const imp = promisedImporter(deps);
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

describe("createImporter: id remapping of tokens / snapshots / activities", () => {
  it("token record: importToken (with ref), builds tokenMap", async () => {
    const { deps, calls } = makeDeps();
    const imp = promisedImporter(deps);
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

  it("snapshot balance token_id remapped via tokenMap; unmappable rows dropped", async () => {
    const { deps, calls } = makeDeps();
    const imp = promisedImporter(deps);
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
        { tokenId: "ghost-tk", amount: 5, usdValue: 5, kind: "spot" },
      ],
    });
    const snap = calls.snapshots[0]!;
    expect(snap.accountId).toBe("acc-2");
    expect(snap.balances).toHaveLength(1);
    expect(snap.balances[0]).toMatchObject({ tokenId: "tk-1", amount: 1 });
  });

  it("activity record: recordManualActivity (accountId/tokenId each remapped); unknown ids skipped", async () => {
    const { deps, calls } = makeDeps();
    const imp = promisedImporter(deps);
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

  it("ignores unknown record types (forward-compat)", async () => {
    const { deps, calls } = makeDeps();
    const imp = promisedImporter(deps);
    await imp.apply({ type: "meta", version: EXPORT_VERSION });
    await imp.apply({ type: "account", id: "old-a", connectorId: "manual", label: "M", creds: {} });
    await imp.apply({ type: "group", id: "old-g", name: "G" });
    await imp.apply({ type: "membership", accountId: "old-a", groupId: "old-g" });
    expect(calls.accounts).toHaveLength(1);
    expect(imp.counts.accounts).toBe(1);
  });
});
