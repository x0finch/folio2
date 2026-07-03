import { type Balance, ProviderError } from "@folio/balances";
import type { AccountSafe, WriteSnapshotInput } from "@folio/db";
import { describe, expect, it, vi } from "vitest";
import { type FetchOutcome, type SyncDeps, type SyncLogger, syncUser } from "../src";

// 编排层测试:provider 机制(解密/校验/取数/全局 key 收窄)已内化进注入的 fetchBalances,
// 这里只测 sync 自己的编排 —— 重试 / 跳过(needs-credentials)/ 重估 / 失败隔离 / 日志 / 写快照。
// 取余额一律用可控 stub 注入(不碰真 provider)。

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

function account(overrides: Partial<AccountSafe> = {}): AccountSafe {
  return {
    id: "a1",
    userId: "u1",
    type: "manual",
    network: null,
    label: "Wallet",
    createdAt: 0,
    ...overrides,
  };
}
const bal = (symbol: string, usdValue: number): Balance => ({
  symbol,
  amount: 1,
  usdValue,
  source: "manual",
  kind: "manual",
});
const ok = (balances: Balance[]): FetchOutcome => ({
  status: "ok",
  balances,
  totalUsd: balances.reduce((s, b) => s + b.usdValue, 0),
});

function makeDeps(
  accounts: AccountSafe[],
  over: Partial<SyncDeps> = {},
): { deps: SyncDeps; writes: Array<{ accountId: string; input: WriteSnapshotInput }> } {
  const writes: Array<{ accountId: string; input: WriteSnapshotInput }> = [];
  const deps: SyncDeps = {
    listAccounts: async () => accounts,
    listRawCreds: async () => [], // 取余额一律 stub,creds 内容无关
    writeSnapshot: async (_userId, accountId, input) => {
      writes.push({ accountId, input });
      return `snap-${accountId}`;
    },
    fetchBalances: async () => ok([]),
    ...over,
  };
  return { deps, writes };
}

describe("syncUser — 取余额 → 写快照", () => {
  it("ok outcome → 写出快照,totalUsd = 各行之和", async () => {
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: async () => ok([bal("BTC", 32000)]),
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0]).toMatchObject({
      accountId: "a1",
      ok: true,
      snapshotId: "snap-a1",
      totalUsd: 32000,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({ totalUsd: 32000 });
    expect(writes[0].input.balances).toHaveLength(1);
  });

  it("revalue 钩子(P7.4.2):写快照前改 usdValue 并重算 totalUsd", async () => {
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: async () => ok([bal("BTC", 32000)]),
      revalue: async (_type, balances) => balances.map((b) => ({ ...b, usdValue: b.usdValue * 2 })),
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0]).toMatchObject({ ok: true, totalUsd: 64000 });
    expect(writes[0].input.totalUsd).toBe(64000);
  });

  it("revalue 抛错 → best-effort 保留原值,账户仍 ok", async () => {
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: async () => ok([bal("BTC", 32000)]),
      revalue: async () => {
        throw new Error("price down");
      },
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0]).toMatchObject({ ok: true, totalUsd: 32000 });
    expect(writes[0].input.totalUsd).toBe(32000);
  });
});

describe("syncUser — 缺凭据跳过 / 失败隔离", () => {
  it("needs-credentials → ok:false skipped:true,不写快照", async () => {
    const { deps, writes } = makeDeps([account({ id: "n" })], {
      fetchBalances: async () => ({ status: "needs-credentials" }),
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0]).toMatchObject({ accountId: "n", ok: false, skipped: true });
    expect(writes).toHaveLength(0);
  });

  it("坏账户 ok:false 不阻断好账户;syncUser 不抛;只为好账户写快照", async () => {
    const good = account({ id: "good" });
    const bad = account({ id: "bad" });
    const { deps, writes } = makeDeps([good, bad], {
      fetchBalances: async (acc) => {
        if (acc.id === "bad") throw new Error("boom");
        return ok([bal("BTC", 1)]);
      },
    });
    const { results } = await syncUser(deps, "u1");
    const byId = Object.fromEntries(results.map((r) => [r.accountId, r]));
    expect(byId.good.ok).toBe(true);
    expect(byId.bad).toMatchObject({ ok: false });
    expect(byId.bad.error).toContain("boom");
    expect(writes).toHaveLength(1);
    expect(writes[0].accountId).toBe("good");
  });
});

describe("结构化日志(级别 + 安全字段)", () => {
  it("成功→info、缺凭据→warning、失败→error;字段只含安全键", async () => {
    const { log, entries } = capturingLogger();
    const { deps } = makeDeps(
      [account({ id: "g" }), account({ id: "n" }), account({ id: "f", type: "exchange_okx" })],
      {
        log,
        fetchBalances: async (acc) => {
          if (acc.id === "n") return { status: "needs-credentials" };
          if (acc.id === "f") throw new ProviderError("AUTH_FAILED", "bad key");
          return ok([bal("BTC", 1)]);
        },
      },
    );
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
  });
});

describe("syncAccount — 退避重试(仅取余额部分)", () => {
  // 前 failTimes 次抛错、之后成功的取余额 stub。
  function flaky(makeErr: () => unknown, failTimes: number) {
    let calls = 0;
    const fetchBalances = async (): Promise<FetchOutcome> => {
      calls++;
      if (calls <= failTimes) throw makeErr();
      return ok([]);
    };
    return { fetchBalances, calls: () => calls };
  }

  it("重试可重试错误并成功;采用 Retry-After(retryAfterMs)", async () => {
    const slept: number[] = [];
    const { fetchBalances, calls } = flaky(
      () => new ProviderError("RATE_LIMITED", "rate limited", { retryAfterMs: 1234 }),
      1,
    );
    const { deps } = makeDeps([account()], {
      fetchBalances,
      sleep: async (ms) => void slept.push(ms),
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0].ok).toBe(true);
    expect(calls()).toBe(2);
    expect(slept[0]).toBeGreaterThanOrEqual(1234);
  });

  it("重试用尽 → ok:false(隔离),不写快照", async () => {
    const slept: number[] = [];
    const { fetchBalances, calls } = flaky(() => new ProviderError("UPSTREAM_ERROR", "5xx"), 99);
    const { deps, writes } = makeDeps([account()], {
      fetchBalances,
      sleep: async (ms) => void slept.push(ms),
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toContain("5xx");
    expect(calls()).toBe(3); // RETRY_MAX_ATTEMPTS
    expect(slept).toHaveLength(2);
    expect(writes).toHaveLength(0);
  });

  it("不可重试错误(AUTH_FAILED)不重试", async () => {
    const slept: number[] = [];
    const { fetchBalances, calls } = flaky(() => new ProviderError("AUTH_FAILED", "bad key"), 99);
    const { deps } = makeDeps([account()], {
      fetchBalances,
      sleep: async (ms) => void slept.push(ms),
    });
    const { results } = await syncUser(deps, "u1");
    expect(results[0].ok).toBe(false);
    expect(calls()).toBe(1);
    expect(slept).toHaveLength(0);
  });
});

describe("syncUser — 有界并发", () => {
  it("同一时刻在飞账户数不超过并发上限,且全部账户都跑到", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const accounts = Array.from({ length: 10 }, (_, i) => account({ id: `a${i}` }));
    const { deps, writes } = makeDeps(accounts, {
      fetchBalances: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5)); // 制造重叠窗口
        inFlight--;
        return ok([]);
      },
    });
    const { results } = await syncUser(deps, "u1");
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(writes).toHaveLength(10);
    expect(maxInFlight).toBe(6); // SYNC_CONCURRENCY;10 账户 > 6 → 恰好打满池
  });
});

describe("syncAccount — 取数超时", () => {
  it("provider 挂住(永不 resolve)→ 超时按 retryable 重试 → 用尽后 ok:false", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { deps, writes } = makeDeps([account()], {
        fetchBalances: () => {
          calls++;
          return new Promise<never>(() => {}); // 永不 resolve
        },
        sleep: async () => {}, // 退避即时(不占 fake timer;超时用真 setTimeout,被 fake 接管)
      });
      const promise = syncUser(deps, "u1");
      // 每次尝试触发一次超时定时器;推进足够时间并冲洗微任务,走完 3 次尝试。
      await vi.advanceTimersByTimeAsync(100_000);
      const { results } = await promise;
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toContain("timed out");
      expect(calls).toBe(3); // RETRY_MAX_ATTEMPTS(超时可重试)
      expect(writes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
