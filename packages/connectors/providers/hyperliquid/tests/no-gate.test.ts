import { bypassGatesForTests, resetGatesForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hyperliquidProvider } from "../src";

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
  bypassGatesForTests(false);
  resetGatesForTests();
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      at.push(Date.now() - t0);
      return new Response(
        JSON.stringify({ marginSummary: { accountValue: "0" }, assetPositions: [] }),
        { status: 200 },
      );
    });

    const runs = Promise.all(
      Array.from({ length: 20 }, () => hyperliquidProvider.fetchBalances(ctx())),
    );
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(60_000);
    await runs;

    expect(at).toHaveLength(20);
    expect(new Set(at).size).toBe(1); // 有闸就会有第二个时刻
  });
});
