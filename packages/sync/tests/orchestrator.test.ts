import { type Balance, ProviderError } from "@folio/connectors-basic";
import type { AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Duration, Effect, Fiber, TestClock, TestContext } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  type FetchOutcome,
  type SyncDeps,
  type SyncLogger,
  syncUser,
  syncUserEffect,
} from "../src";

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
    connectorId: "manual",
    platform: null,
    label: "Wallet",
    createdAt: 0,
    archivedAt: null,
    ...overrides,
  };
}
const bal = (symbol: string, value: number): Balance => ({
  symbol,
  tokenRef: `binance/issued:${symbol}`,
  amount: 1,
  value,
  kind: "spot",
});
const ok = (balances: Balance[]): FetchOutcome => ({
  status: "ok",
  balances,
  totalUsd: balances.reduce((s, b) => s + b.value, 0),
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

  it("note(note 重设计,两级):balance 级单个 note 随行透传 + account 级 Note[] 落顶层", async () => {
    const note = { title: "Locked", icon: "warning" as const, content: "held" };
    const withNote: Balance = { ...bal("BTC", 1), note };
    const accountNote = [{ title: "Unconfirmed", icon: "warning" as const, content: "pending" }];
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: async () => ({
        status: "ok",
        balances: [withNote, bal("ETH", 2)],
        totalUsd: 3,
        note: accountNote,
      }),
    });
    await syncUser(deps, "u1");
    // 带 note 的行透传单个 note;无 note 的行 note=undefined。
    expect(writes[0].input.balances[0]?.note).toEqual(note);
    expect(writes[0].input.balances[1]?.note).toBeUndefined();
    // account 级 note(Note[])落 writeSnapshot 顶层。
    expect(writes[0].input.note).toEqual(accountNote);
  });

  it("revalue 钩子(P7.4.2):写快照前改 value 并重算 totalUsd", async () => {
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: async () => ok([bal("BTC", 32000)]),
      revalue: async (_userId, _type, balances) =>
        balances.map((b) => ({ ...b, value: b.value * 2 })),
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
      [account({ id: "g" }), account({ id: "n" }), account({ id: "f", connectorId: "okx" })],
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
    expect(byMsg("account synced")?.props).toMatchObject({ accountId: "g", connectorId: "manual" });
    expect(byMsg("account sync skipped: needs credentials")?.level).toBe("warning");
    expect(byMsg("account sync failed")?.level).toBe("error");
    expect(byMsg("account sync failed")?.props).toMatchObject({
      accountId: "f",
      code: "AUTH_FAILED",
    });
  });
});

// 退避重试测在 **Effect 版内核** 上(`syncUserEffect`),不是 Promise 壳 —— 假时钟(`TestClock`)与
// 可控随机(抖动)都要 Effect 上下文,而壳子在包内部就把上下文 runPromise 掉了,外面挂不上。
// 内核下一步(出口也改成 Effect)会转正成正式出口,所以这不是为测试开的临时缝。
//
// 套路:fork 起来 → 推进假时钟 → join。真实时钟下这几条会各等好几秒;假时钟下瞬间跑完,
// 且能**精确**断言退避了多久(推进 199ms 不该有第二次调用,推到 200ms 才有)。
describe("syncUser(Effect 内核)— 退避重试(仅取余额部分)", () => {
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

  // 跑一段用了假时钟的 Effect:fork → 推进 → join。推进量给足(覆盖所有退避),
  // 不逐段推进的用例用它;要精确卡时间点的自己 fork。
  const runWithClock = <A>(effect: Effect.Effect<A>, advanceMs = 100_000): Promise<A> =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(effect);
      yield* TestClock.adjust(Duration.millis(advanceMs));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);

  it("重试可重试错误并成功;采用 Retry-After(retryAfterMs)", async () => {
    const { fetchBalances, calls } = flaky(
      () => new ProviderError("RATE_LIMITED", "rate limited", { retryAfterMs: 1234 }),
      1,
    );
    const { deps } = makeDeps([account()], { fetchBalances });
    const { results } = await runWithClock(syncUserEffect(deps, "u1"));
    expect(results[0].ok).toBe(true);
    expect(calls()).toBe(2);
  });

  it("采用 Retry-After 而非自己的指数退避:1233ms 时还没重试,1234ms 后才重试", async () => {
    const { fetchBalances, calls } = flaky(
      () => new ProviderError("RATE_LIMITED", "rate limited", { retryAfterMs: 1234 }),
      1,
    );
    const { deps } = makeDeps([account()], { fetchBalances });
    await Effect.gen(function* () {
      const fiber = yield* Effect.fork(syncUserEffect(deps, "u1"));
      // 指数退避的第一档是 200ms;若没采用 Retry-After,这时早该重试了。
      yield* TestClock.adjust(Duration.millis(1233));
      expect(calls()).toBe(1);
      // 抖动最多再加一个 baseMs(200ms),推够即可。
      yield* TestClock.adjust(Duration.millis(400));
      yield* Fiber.join(fiber);
      expect(calls()).toBe(2);
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
  });

  it("退避曲线逐档翻倍:第二档是 400ms 而不是又一个 200ms", async () => {
    // 抖动是加性的(+0~baseMs),所以每档都是一个**区间**,断言必须卡区间边界而不是某个点位,
    // 否则测试会随抖动大小时绿时红 —— 时序测试自己不确定就白写了。
    //   第 2 次调用 ∈ [200, 400]   (第一档 200 + 抖动 0~200)
    //   第 3 次调用 ∈ [600, 1000]  (第 2 次时刻 + 第二档 400 + 抖动 0~200)
    // 「第 3 次不早于 600」正是「第二档翻倍到 400」的证据 —— 若第二档仍是 200,它最早会在 400 出现。
    const { fetchBalances, calls } = flaky(
      () => new ProviderError("UPSTREAM_ERROR", "5xx"), // 无 Retry-After → 走指数退避
      2,
    );
    const { deps } = makeDeps([account()], { fetchBalances });
    await Effect.gen(function* () {
      const fiber = yield* Effect.fork(syncUserEffect(deps, "u1"));
      yield* TestClock.adjust(Duration.millis(199));
      expect(calls()).toBe(1); // 第一档最早 200ms,未到
      yield* TestClock.adjust(Duration.millis(201)); // → t=400,第 2 次最晚也该发生了
      expect(calls()).toBe(2);
      yield* TestClock.adjust(Duration.millis(199)); // → t=599,第 3 次最早 600
      expect(calls()).toBe(2);
      yield* TestClock.adjust(Duration.millis(401)); // → t=1000,第 3 次最晚也该发生了
      yield* Fiber.join(fiber);
      expect(calls()).toBe(3);
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
  });

  it("Retry-After 超过单次上限 → 夹到上限继续等,不放弃(clamp 语义)", async () => {
    // 后台同步没人在等:上游说等 60s、我们上限 5s → 夹到 5s 再打,而不是直接失败。
    const { fetchBalances, calls } = flaky(
      () => new ProviderError("RATE_LIMITED", "slow down", { retryAfterMs: 60_000 }),
      1,
    );
    const { deps } = makeDeps([account()], { fetchBalances });
    await Effect.gen(function* () {
      const fiber = yield* Effect.fork(syncUserEffect(deps, "u1"));
      yield* TestClock.adjust(Duration.millis(4999));
      expect(calls()).toBe(1);
      yield* TestClock.adjust(Duration.millis(1201)); // 5s 上限 + 抖动上限 200ms
      const { results } = yield* Fiber.join(fiber);
      expect(calls()).toBe(2); // 夹到 5s 后重试成功,而非等满 60s、也非放弃
      expect(results[0].ok).toBe(true);
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
  });

  it("重试用尽 → ok:false(隔离),不写快照", async () => {
    const { fetchBalances, calls } = flaky(() => new ProviderError("UPSTREAM_ERROR", "5xx"), 99);
    const { deps, writes } = makeDeps([account()], { fetchBalances });
    const { results } = await runWithClock(syncUserEffect(deps, "u1"));
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toContain("5xx");
    expect(calls()).toBe(3); // RETRY_MAX_ATTEMPTS
    expect(writes).toHaveLength(0);
  });

  it("不可重试错误(AUTH_FAILED)不重试", async () => {
    const { fetchBalances, calls } = flaky(() => new ProviderError("AUTH_FAILED", "bad key"), 99);
    const { deps } = makeDeps([account()], { fetchBalances });
    const { results } = await runWithClock(syncUserEffect(deps, "u1"));
    expect(results[0].ok).toBe(false);
    expect(calls()).toBe(1);
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

describe("syncUser(Effect 内核)— 取数超时", () => {
  it("provider 挂住(永不 resolve)→ 超时按 retryable 重试 → 用尽后 ok:false", async () => {
    let calls = 0;
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: () => {
        calls++;
        return new Promise<never>(() => {}); // 永不 resolve
      },
    });
    await Effect.gen(function* () {
      const fiber = yield* Effect.fork(syncUserEffect(deps, "u1"));
      // 3 次尝试 × 20s 超时 + 两次退避,推够即可。
      yield* TestClock.adjust(Duration.millis(100_000));
      const { results } = yield* Fiber.join(fiber);
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toContain("timed out");
      expect(calls).toBe(3); // RETRY_MAX_ATTEMPTS(超时可重试)
      expect(writes).toHaveLength(0);
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
  });

  it("每次尝试各自计时:19.9s 时还没超时,20s 后才判超时并重试", async () => {
    let calls = 0;
    const { deps } = makeDeps([account()], {
      fetchBalances: () => {
        calls++;
        return new Promise<never>(() => {});
      },
    });
    await Effect.gen(function* () {
      const fiber = yield* Effect.fork(syncUserEffect(deps, "u1"));
      yield* TestClock.adjust(Duration.millis(19_900));
      expect(calls).toBe(1); // FETCH_TIMEOUT_MS 未到
      // 20s 超时 + 第一档退避 200 + 抖动上限 200 → 第 2 次最晚在 20_400,推到 20_500 留余量。
      yield* TestClock.adjust(Duration.millis(600));
      expect(calls).toBe(2);
      yield* Effect.fork(Fiber.interrupt(fiber)); // 收尾,不等剩下两次
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
  });
});

// —— mint:认币是独立一步,跑在 revalue 之前(#202)——
//
// #200 当初把 mint 塞在注入的 writeSnapshot 里。那时 revalue 还在用旧参考层的读时解析,所以两者
// 互不相干;新层的 `priceOf` 收 token_id,mint 要是留在写快照那头,revalue 就得自己再认一遍 ——
// 同一轮同步认两次,而且中间有别的账户在并发建行,两次答案可能不一致。
//
// 下面钉的就是这条顺序契约:**mint 先跑、只跑一次、答案同时喂给 revalue 与写快照**。
// 顺序错了这几条会红;换成在调用方复刻这段逻辑就测不到了。
describe("syncAccount — mint 与 revalue 的顺序", () => {
  it("mint 先于 revalue,且 revalue 拿到的就是 mint 的答案", async () => {
    const order: string[] = [];
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: async () => ok([bal("BTC", 100)]),
      mint: async (_userId, balances) => {
        order.push("mint");
        return new Map(balances.map((b) => [b.tokenRef as string, `tk_${b.symbol}`]));
      },
      revalue: async (_userId, _cid, balances, idByRef) => {
        order.push("revalue");
        // 拿到的正是上一步的产物 —— 自己不解析身份。
        expect(idByRef.get("binance/issued:BTC")).toBe("tk_BTC");
        return balances;
      },
    });

    await syncUser(deps, "u1");
    expect(order).toEqual(["mint", "revalue"]);
    // 同一份答案也落进了快照列。
    expect(writes[0].input.balances[0].tokenId).toBe("tk_BTC");
  });

  it("一轮同步只 mint 一次(写快照不再自己认一遍)", async () => {
    let calls = 0;
    const { deps } = makeDeps([account()], {
      fetchBalances: async () => ok([bal("BTC", 100), bal("ETH", 50)]),
      mint: async (_userId, balances) => {
        calls++;
        return new Map(balances.map((b) => [b.tokenRef as string, `tk_${b.symbol}`]));
      },
    });

    await syncUser(deps, "u1");
    expect(calls).toBe(1); // 两笔持仓、一次批量点查
  });

  // best-effort:认币故障不该让一轮同步丢数据。
  it("mint 抛错 → 快照照落(token_id 留空)、价退回 provider 自带、记一条 warning", async () => {
    const { log, entries } = capturingLogger();
    const { deps, writes } = makeDeps([account()], {
      log,
      fetchBalances: async () => ok([bal("BTC", 100)]),
      mint: async () => {
        throw new Error("d1 down");
      },
      revalue: async (_userId, _cid, balances, idByRef) => {
        expect(idByRef.size).toBe(0); // 空 map,不是 undefined —— revalue 不用判空
        return balances;
      },
    });

    await syncUser(deps, "u1");
    expect(writes).toHaveLength(1);
    expect(writes[0].input.balances[0].tokenId).toBeUndefined();
    expect(writes[0].input.totalUsd).toBe(100); // 金额没丢
    expect(entries.some((e) => e.level === "warning" && e.msg.includes("mint failed"))).toBe(true);
  });

  it("没注入 mint(旧装配 / 测试)→ 整条路照跑,token_id 留空", async () => {
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: async () => ok([bal("BTC", 100)]),
    });
    await syncUser(deps, "u1");
    expect(writes[0].input.balances[0].tokenId).toBeUndefined();
  });

  it("认不出来的那条 ref 不进 map → 它的 token_id 留空,别的行不受影响", async () => {
    const { deps, writes } = makeDeps([account()], {
      fetchBalances: async () => ok([bal("BTC", 100), bal("SCAM", 5)]),
      mint: async () => new Map([["binance/issued:BTC", "tk_BTC"]]),
    });

    await syncUser(deps, "u1");
    // symbol 不再落快照(#243);按 usdValue 区分两行(BTC=100 / SCAM=5)。
    const rows = writes[0].input.balances;
    expect(rows.find((r) => r.usdValue === 100)?.tokenId).toBe("tk_BTC");
    expect(rows.find((r) => r.usdValue === 5)?.tokenId).toBeUndefined();
  });
});
