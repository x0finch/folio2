import {
  type BalanceProvider,
  buildRegistry,
  encrypt,
  generateSecret,
  ProviderError,
} from "@folio/core";
import type { AccountSafe, WriteSnapshotInput } from "@folio/db";
import { customProvider } from "@folio/provider-custom";
import { beforeEach, describe, expect, it } from "vitest";
import { runAccountSync, type SyncDeps, syncUser } from "../src";
import { appRegistry } from "../src/registry";

const secretsKey = generateSecret();

// 一个 manual 账户的安全形状(dataJson 明文持仓;encCredentials 在 deps 里给加密的 {})。
function manualAccount(overrides: Partial<AccountSafe> = {}): AccountSafe {
  return {
    id: "a-manual",
    userId: "u1",
    type: "manual",
    network: null,
    label: "Manual wallet",
    dataJson: JSON.stringify({
      holdings: [
        { symbol: "BTC", amount: 0.5, usdValue: 32000 },
        { symbol: "ETH", amount: 4, usdValue: 12000 },
      ],
    }),
    createdAt: 0,
    ...overrides,
  };
}

// 收集 writeSnapshot 调用,便于断言传入形状。
function makeDeps(
  accounts: AccountSafe[],
  over: Partial<SyncDeps> = {},
): { deps: SyncDeps; writes: Array<{ accountId: string; input: WriteSnapshotInput }> } {
  const writes: Array<{ accountId: string; input: WriteSnapshotInput }> = [];
  const deps: SyncDeps = {
    listAccounts: async () => accounts,
    getEncryptedCredentials: async () => encrypt(JSON.stringify({}), secretsKey),
    writeSnapshot: async (_userId, accountId, input) => {
      writes.push({ accountId, input });
      return `snap-${accountId}`;
    },
    secretsKey,
    globalKeys: {},
    ...over,
  };
  return { deps, writes };
}

describe("syncUser — manual 端到端", () => {
  let encCreds: string;
  beforeEach(async () => {
    encCreds = await encrypt(JSON.stringify({}), secretsKey);
  });

  it("解密 → 组 FetchContext → 写出 manual 快照(kind/source=manual,totalUsd 求和)", async () => {
    const account = manualAccount();
    const { deps, writes } = makeDeps([account], {
      getEncryptedCredentials: async () => encCreds,
    });

    const { results } = await syncUser(deps, "u1");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      accountId: "a-manual",
      ok: true,
      snapshotId: "snap-a-manual",
      totalUsd: 44000,
    });

    expect(writes).toHaveLength(1);
    const { input } = writes[0];
    expect(input.totalUsd).toBe(44000);
    expect(input.balances).toHaveLength(2);
    for (const b of input.balances) {
      expect(b.kind).toBe("manual");
      expect(b.source).toBe("manual");
    }
    expect(input.balances.find((b) => b.symbol === "BTC")?.usdValue).toBe(32000);
  });
});

describe("syncUser — 失败隔离", () => {
  // 一个对 exchange_binance 抛错的假 provider,与真实 manual provider 共存。
  const throwing: BalanceProvider = {
    accountType: "exchange_binance",
    fetchBalances: async () => {
      throw new Error("boom");
    },
    validate: async () => true,
  };
  const registry = buildRegistry([customProvider, throwing]);

  it("坏账户 ok:false 不阻断好账户;syncUser 不抛;只为好账户写快照", async () => {
    const good = manualAccount({ id: "good" });
    const bad = manualAccount({ id: "bad", type: "exchange_binance", dataJson: null });
    const { deps, writes } = makeDeps([good, bad], { registry });

    const { results } = await syncUser(deps, "u1");

    const byId = Object.fromEntries(results.map((r) => [r.accountId, r]));
    expect(byId.good.ok).toBe(true);
    expect(byId.good.snapshotId).toBe("snap-good");
    expect(byId.bad.ok).toBe(false);
    expect(byId.bad.error).toContain("boom");

    // 只为好账户写了快照(坏账户失败前不写)。
    expect(writes).toHaveLength(1);
    expect(writes[0].accountId).toBe("good");
  });
});

describe("syncAccount — 缺凭据跳过", () => {
  it("encCredentials=null(导入待补录)→ ok:false skipped:true,不拉取/不写快照", async () => {
    const acc = manualAccount({ id: "needs", type: "exchange_binance", dataJson: null });
    const { deps, writes } = makeDeps([acc], {
      getEncryptedCredentials: async () => null, // 缺凭据
    });

    const { results } = await syncUser(deps, "u1");

    expect(results[0]).toMatchObject({ accountId: "needs", ok: false, skipped: true });
    expect(writes).toHaveLength(0);
  });
});

describe("runAccountSync — 求和与空持仓", () => {
  it("totalUsd 为各持仓之和", async () => {
    const account = manualAccount();
    const data = JSON.parse(account.dataJson as string);
    const { balances, totalUsd } = await runAccountSync(appRegistry, {
      account: { id: "x", userId: "u1", type: "manual", label: "M", data },
      creds: {},
      globalKeys: {},
    });
    expect(balances).toHaveLength(2);
    expect(totalUsd).toBe(44000);
  });

  it("无持仓 → 空 balances、totalUsd 0,仍写空快照", async () => {
    const empty = manualAccount({ id: "empty", dataJson: null });
    const { deps, writes } = makeDeps([empty]);

    const { results } = await syncUser(deps, "u1");

    expect(results[0]).toMatchObject({ accountId: "empty", ok: true, totalUsd: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0].input.balances).toHaveLength(0);
    expect(writes[0].input.totalUsd).toBe(0);
  });
});

describe("syncAccount — 全局 key 最小权限下发", () => {
  it("provider 只拿到 usesGlobalKeys 声明的 key,拿不到别家的", async () => {
    let seen: Record<string, string> | undefined;
    // 声明只用 ZERION_API_KEY 的捕获式假 provider。
    const capturing: BalanceProvider = {
      accountType: "onchain_evm",
      usesGlobalKeys: ["ZERION_API_KEY"],
      fetchBalances: async (ctx) => {
        seen = ctx.globalKeys;
        return [];
      },
      validate: async () => true,
    };
    const registry = buildRegistry([capturing]);
    const account = manualAccount({ id: "evm", type: "onchain_evm", dataJson: null });
    const { deps } = makeDeps([account], {
      registry,
      globalKeys: { ZERION_API_KEY: "zk", OTHER_KEY: "secret" },
    });

    await syncUser(deps, "u1");

    expect(seen).toEqual({ ZERION_API_KEY: "zk" });
    expect(seen).not.toHaveProperty("OTHER_KEY");
  });

  it("未声明 usesGlobalKeys 的 provider 拿到空对象", async () => {
    let seen: Record<string, string> | undefined;
    const noKeys: BalanceProvider = {
      accountType: "onchain_evm",
      fetchBalances: async (ctx) => {
        seen = ctx.globalKeys;
        return [];
      },
      validate: async () => true,
    };
    const registry = buildRegistry([noKeys]);
    const account = manualAccount({ id: "evm", type: "onchain_evm", dataJson: null });
    const { deps } = makeDeps([account], {
      registry,
      globalKeys: { ZERION_API_KEY: "zk", OTHER_KEY: "secret" },
    });

    await syncUser(deps, "u1");

    expect(seen).toEqual({});
  });
});

describe("syncAccount — 退避重试", () => {
  // 构造一个对 onchain_evm 的假 provider:前 failTimes 次抛错,之后成功。
  function flakyRegistry(makeErr: () => unknown, failTimes: number) {
    let calls = 0;
    const provider: BalanceProvider = {
      accountType: "onchain_evm",
      fetchBalances: async () => {
        calls++;
        if (calls <= failTimes) throw makeErr();
        return [];
      },
      validate: async () => true,
    };
    return { registry: buildRegistry([provider]), calls: () => calls };
  }
  const evm = () => manualAccount({ id: "evm", type: "onchain_evm", dataJson: null });

  it("retries a retryable error and succeeds; honors Retry-After (retryAfterMs)", async () => {
    const slept: number[] = [];
    const { registry, calls } = flakyRegistry(
      () => new ProviderError("RATE_LIMITED", "rate limited", { retryAfterMs: 1234 }),
      1, // 第 1 次失败,第 2 次成功
    );
    const { deps } = makeDeps([evm()], {
      registry,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const { results } = await syncUser(deps, "u1");

    expect(results[0].ok).toBe(true);
    expect(calls()).toBe(2); // 重试了一次
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(1234); // 采用了 Retry-After
  });

  it("gives up after RETRY_MAX_ATTEMPTS → ok:false (isolated)", async () => {
    const slept: number[] = [];
    const { registry, calls } = flakyRegistry(
      () => new ProviderError("UPSTREAM_ERROR", "5xx"),
      99, // 一直失败
    );
    const { deps, writes } = makeDeps([evm()], {
      registry,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const { results } = await syncUser(deps, "u1");

    expect(results[0]).toMatchObject({ accountId: "evm", ok: false });
    expect(results[0].error).toContain("5xx");
    expect(calls()).toBe(3); // RETRY_MAX_ATTEMPTS
    expect(slept).toHaveLength(2); // 两次退避
    expect(writes).toHaveLength(0); // 没写快照
  });

  it("does not retry a non-retryable error (e.g. AUTH_FAILED)", async () => {
    const slept: number[] = [];
    const { registry, calls } = flakyRegistry(
      () => new ProviderError("AUTH_FAILED", "bad key"),
      99,
    );
    const { deps } = makeDeps([evm()], {
      registry,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const { results } = await syncUser(deps, "u1");

    expect(results[0].ok).toBe(false);
    expect(calls()).toBe(1); // 不重试
    expect(slept).toHaveLength(0);
  });
});
