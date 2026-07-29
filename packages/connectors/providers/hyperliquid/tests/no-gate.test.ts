import { resetLimitsForTests, setSleepForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hyperliquidProvider } from "../src";

// hyperliquid **刻意没有速率闸** —— 见 src/constants.ts 末尾算的那笔账:
// 1200 权重/分钟 ÷ 每次权重 2 ≈ 600 次/分钟,而我们峰值 6 发。桶永远是满的,闸拦不到任何东西。
// 这个文件钉住现状,免得下一个人照着「别的 provider 都有」补一个上来。
// 哪天这里改成按币种逐个问,就该回去重算那笔账 —— 那时这个文件该被删掉,不是被加断言。

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

beforeEach(() => resetLimitsForTests());
afterEach(() => {
  setSleepForTests();
  vi.restoreAllMocks();
});

describe("hyperliquid 没有闸", () => {
  it("连发很多次都不等", async () => {
    const waits: number[] = [];
    setSleepForTests(async (ms) => void waits.push(ms));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ marginSummary: { accountValue: "0" }, assetPositions: [] }), {
          status: 200,
        }),
    );
    for (let i = 0; i < 20; i++) await hyperliquidProvider.fetchBalances(ctx());
    expect(waits).toEqual([]);
  });

  it("撞了 429 也不进冷却 —— 下一发照样出网", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return new Response("", { status: 429 });
    });
    await expect(hyperliquidProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await expect(hyperliquidProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(calls).toBe(2);
  });
});
