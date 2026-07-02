import {
  registry as appRegistry,
  type BalanceProvider,
  buildRegistry,
  generateSecret,
  ProviderError,
} from "@folio/balances";
import { customProvider } from "@folio/balances-provider-custom";
import type { AccountSafe, WriteSnapshotInput } from "@folio/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAccountSync, type SyncDeps, type SyncLogger, syncUser } from "../src";

// 捕获式 logger:记录 (level, msg, props),供断言级别 + 安全字段 + 红线(无密钥)。
function capturingLogger() {
  const entries: Array<{ level: string; msg: string; props?: Record<string, unknown> }> = [];
  const mk = (level: string) => (msg: string, props?: Record<string, unknown>) =>
    entries.push({ level, msg, props });
  const log: SyncLogger = {
    debug: mk("debug"),
    info: mk("info"),
    warning: mk("warning"),
    error: mk("error"),
  };
  return { log, entries };
}

const secretsKey = generateSecret();

// 一个账户的安全形状(creds map 经 deps.getRawCreds 提供;manual 持仓也走 creds,见 P6.6.2)。
function manualAccount(overrides: Partial<AccountSafe> = {}): AccountSafe {
  return {
    id: "a-manual",
    userId: "u1",
    type: "manual",
    network: null,
    label: "Manual wallet",
    createdAt: 0,
    ...overrides,
  };
}
// manual 的单资产 creds(走 getRawCreds;creds map 是字符串 map,amount/usdValue 由 validator coerce 成 number)。
const MANUAL_CREDS = JSON.stringify({ symbol: "BTC", amount: "0.5", unitPrice: "64000" });

// 收集 writeSnapshot 调用,便于断言传入形状。getRawCreds 默认给空 map "{}"(manual 无输入 → isComplete)。
function makeDeps(
  accounts: AccountSafe[],
  over: Partial<SyncDeps> = {},
): { deps: SyncDeps; writes: Array<{ accountId: string; input: WriteSnapshotInput }> } {
  const writes: Array<{ accountId: string; input: WriteSnapshotInput }> = [];
  const deps: SyncDeps = {
    listAccounts: async () => accounts,
    getRawCreds: async () => "{}",
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
  it("creds(symbol/amount/usdValue)→ 组 FetchContext → 写出单条 manual 快照", async () => {
    const account = manualAccount();
    const { deps, writes } = makeDeps([account], { getRawCreds: async () => MANUAL_CREDS });

    const { results } = await syncUser(deps, "u1");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      accountId: "a-manual",
      ok: true,
      snapshotId: "snap-a-manual",
      totalUsd: 32000,
    });

    expect(writes).toHaveLength(1);
    const { input } = writes[0];
    expect(input.totalUsd).toBe(32000);
    expect(input.balances).toHaveLength(1);
    expect(input.balances[0]).toMatchObject({
      symbol: "BTC",
      amount: 0.5,
      usdValue: 32000,
      kind: "manual",
      source: "manual",
    });
  });

  it("revalue 钩子(P7.4.2):写快照前改 usdValue 并重算 totalUsd", async () => {
    const { deps, writes } = makeDeps([manualAccount()], {
      getRawCreds: async () => MANUAL_CREDS,
      revalue: async (_type, balances) => balances.map((b) => ({ ...b, usdValue: b.usdValue * 2 })),
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0]).toMatchObject({ ok: true, totalUsd: 64000 }); // 32000 × 2
    expect(writes[0].input.totalUsd).toBe(64000);
    expect(writes[0].input.balances[0].usdValue).toBe(64000);
  });

  it("revalue 抛错 → best-effort 保留 provider 原值,账户仍 ok", async () => {
    const { deps, writes } = makeDeps([manualAccount()], {
      getRawCreds: async () => MANUAL_CREDS,
      revalue: async () => {
        throw new Error("price down");
      },
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0]).toMatchObject({ ok: true, totalUsd: 32000 });
    expect(writes[0].input.totalUsd).toBe(32000);
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
    const bad = manualAccount({ id: "bad", type: "exchange_binance" });
    // good=manual 用真 creds 成功;bad 走 throwing(无 inputs → isComplete 通过)→ fetch 抛 boom。
    const { deps, writes } = makeDeps([good, bad], {
      registry,
      getRawCreds: async () => MANUAL_CREDS,
    });

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

describe("结构化日志(级别 + 安全字段 + 红线)", () => {
  it("成功→info、缺凭据→warning、失败→error;字段只含安全键、无密钥", async () => {
    const throwing: BalanceProvider = {
      accountType: "exchange_okx",
      fetchBalances: async () => {
        throw new ProviderError("AUTH_FAILED", "bad key");
      },
      validate: async () => true,
    };
    // 带 semi/secret 输入的假 binance:creds "{}" → !isComplete → 缺凭据跳过。
    const fakeBinance: BalanceProvider = {
      accountType: "exchange_binance",
      inputs: [
        { key: "apiKey", type: "semi", label: "API Key", validator: z.string().min(1) },
        { key: "secret", type: "secret", label: "API Secret", validator: z.string().min(1) },
      ],
      fetchBalances: async () => [],
      validate: async () => true,
    };
    const registry = buildRegistry([customProvider, throwing, fakeBinance]);
    const good = manualAccount({ id: "g" });
    const needs = manualAccount({ id: "n", type: "exchange_binance" }); // creds "{}" → 缺凭据
    const fail = manualAccount({ id: "f", type: "exchange_okx" }); // throwing → error

    const { log, entries } = capturingLogger();
    // 各账户 getRawCreds:good=manual creds;okx=有完整 creds(过 isComplete)走 throwing;binance="{}" 缺凭据。
    const { deps } = makeDeps([good, needs, fail], {
      registry,
      getRawCreds: async (_u, id) =>
        id === "g"
          ? MANUAL_CREDS
          : id === "f"
            ? JSON.stringify({ apiKey: "K", secret: "S", passphrase: "P" })
            : "{}",
      log,
    });

    await syncUser(deps, "u1");

    const byMsg = (m: string) => entries.find((e) => e.msg === m);
    expect(byMsg("account synced")?.level).toBe("info");
    expect(byMsg("account synced")?.props).toMatchObject({ accountId: "g", type: "manual" });
    expect(byMsg("account sync skipped: needs credentials")?.level).toBe("warning");
    expect(byMsg("account sync failed")?.level).toBe("error");
    expect(byMsg("account sync failed")?.props).toMatchObject({
      accountId: "f",
      code: "AUTH_FAILED",
    });

    // 红线:任何日志字段都不含密钥真值(K/S/P)。
    const blob = JSON.stringify(entries);
    for (const secret of ['"K"', '"S"', '"P"']) expect(blob).not.toContain(secret);
  });
});

describe("syncAccount — 缺凭据跳过", () => {
  it("!isComplete(导入待补录:binance 的 apiKey/secret 缺真值)→ ok:false skipped:true,不拉取/不写快照", async () => {
    // 用真 appRegistry(binance 有 apiKey(semi)+secret(secret) 输入);creds 为空 map → 不完整。
    const acc = manualAccount({ id: "needs", type: "exchange_binance" });
    const { deps, writes } = makeDeps([acc], { getRawCreds: async () => "{}" });

    const { results } = await syncUser(deps, "u1");

    expect(results[0]).toMatchObject({ accountId: "needs", ok: false, skipped: true });
    expect(writes).toHaveLength(0);
  });
});

describe("runAccountSync — 求和与空 balances", () => {
  it("manual 单资产 → 单条 balance,totalUsd = usdValue", async () => {
    const { balances, totalUsd } = await runAccountSync(appRegistry, {
      account: { id: "x", userId: "u1", type: "manual", label: "M" },
      creds: { symbol: "BTC", amount: 0.5, unitPrice: 64000 },
      globalKeys: {},
    });
    expect(balances).toHaveLength(1);
    expect(totalUsd).toBe(32000);
  });

  it("provider 返回空 balances → ok:true、totalUsd 0、仍写空快照", async () => {
    const emptyProvider: BalanceProvider = {
      accountType: "onchain_evm",
      fetchBalances: async () => [],
      validate: async () => true,
    };
    const registry = buildRegistry([emptyProvider]);
    const acc = manualAccount({ id: "empty", type: "onchain_evm" });
    const { deps, writes } = makeDeps([acc], { registry }); // 无 inputs → isComplete("{}") 通过

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
    const account = manualAccount({ id: "evm", type: "onchain_evm" });
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
    const account = manualAccount({ id: "evm", type: "onchain_evm" });
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
  const evm = () => manualAccount({ id: "evm", type: "onchain_evm" });

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
