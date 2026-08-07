import type { ConnectorError } from "@folio/connectors-basic";
import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hyperliquidProvider } from "../src";

// 契约的出口是 Effect(ADR 0035)。把它接回 vitest 的 async 断言:
// `run` 拿成功值;`failing` 拿**错误值本身** —— 不用 `.rejects`,因为 `runPromise` 抛的是包了
// 一层的 `FiberFailure`,`toMatchObject` 看不见里面的 `_tag`。
const run = <A>(effect: Effect.Effect<A, ConnectorError>): Promise<A> => Effect.runPromise(effect);

// hyperliquid **刻意没有速率闸**,这个文件就是钉住这件事的 —— 不然下一个人看到别的 provider 都有闸,
// 会顺手补一个上来。
//
// 见 src/constants.ts 末尾算的那笔账:1200 权重/分钟 ÷ 每次权重 2 ≈ 600 次/分钟,而我们峰值 6 发。
// 队永远是空的,闸拦不到任何东西。哪天这里改成按币种逐个问,就该回去重算那笔账 ——
// 那时这个文件该被删掉,不是被加断言。
//
// 怎么钉:闸旁路**关掉**(所以如果有闸,它会真的生效),然后连发很多次并断言全部挤在同一刻。
// 有闸的话额度一用完就会出现第二个时刻。

type Ctx = Parameters<typeof hyperliquidProvider.fetchBalances>[0];
const ctx = (): Ctx =>
  ({
    account: {
      id: "a1",
      label: "HL",
      connectorId: "hyperliquid",
      creds: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    },
    creds: {},
  }) as unknown as Ctx;

beforeEach(() => {
  bypassRateLimitsForTests(false);
  resetRateLimitsForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hyperliquid 没有闸", () => {
  it("连发 20 次,全部在同一刻出去 —— 一次等待都没有", async () => {
    const at: number[] = [];
    const t0 = Date.now();
    // 每次新建 Response(body 只能读一次,不能 mockResolvedValue 复用同一个实例)。
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      at.push(Date.now() - t0);
      return new Response(
        JSON.stringify({ marginSummary: { accountValue: "0" }, assetPositions: [] }),
        { status: 200 },
      );
    });

    // **不推进时钟**:无闸 → 没有一次 setTimeout 等待,20 发全靠微任务/异步 resolve、时钟没动 →
    // 全落同一刻。原来那版多推 3×60s,把异步 resolve 落在推进之后的请求切到别的时刻 → 偶发 flaky
    // (实测 okx 那条)。有闸的话这里会卡在 setTimeout 上(假时钟不推就不 resolve)→ 超时报红。
    await Promise.all(
      Array.from({ length: 20 }, () => run(hyperliquidProvider.fetchBalances(ctx()))),
    );

    expect(at).toHaveLength(20);
    expect(new Set(at).size).toBe(1);
  });
});
