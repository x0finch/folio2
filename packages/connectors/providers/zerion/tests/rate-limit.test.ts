import { resetLimitsForTests, setSleepForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChainIdsCacheForTests, zerionProvider } from "../src";
import chainsFixture from "./fixtures/chains.json";
import positionsFixture from "./fixtures/positions.json";

// 一次 fetchBalances 发 2 个请求,而且是 `Promise.all` **并行**的 —— 本文件钉的是「并行的那两发
// 也各占一个时隙」。要是哪天有人以为「反正在 Promise.all 里」就绕开闸,6 个账户就是瞬时 12 发,
// 越过免费档 10 RPS 的线。

type Ctx = Parameters<typeof zerionProvider.fetchBalances>[0];
const ctx = (): Ctx =>
  ({
    account: {
      id: "a1",
      label: "W",
      connectorId: "evm",
      creds: { address: "0x1111111111111111111111111111111111111111" },
    },
    creds: { ZERION_API_KEY: "k" },
  }) as unknown as Ctx;

// 每次都新建 Response —— 同一个实例的 body 只能读一次。
function stubOk() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const body = String(input).includes("/chains") ? chainsFixture : positionsFixture;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  resetLimitsForTests();
  resetChainIdsCacheForTests();
});
afterEach(() => {
  setSleepForTests();
  vi.restoreAllMocks();
});

describe("速率闸", () => {
  it("并行的两发各占一个时隙 —— 容量用尽后开始摊开", async () => {
    const waits: number[] = [];
    setSleepForTests(async (ms) => void waits.push(ms));
    stubOk();

    // 容量 8。第一轮花 2 个额度(链清单 + positions 并行),之后链清单走 24h 缓存,每轮只花 1 个
    // → 7 轮正好 2 + 6 = 8 发,刚好吃完突发额度,一次都不用等。
    for (let i = 0; i < 7; i++) await zerionProvider.fetchBalances(ctx());
    expect(waits).toEqual([]);

    await zerionProvider.fetchBalances(ctx());
    expect(waits).toHaveLength(1); // 第 9 发开始排队
    expect(waits[0]).toBeGreaterThan(0);
  });

  it("撞了 429 → 进冷却,下一发压根不出网", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 429 }));
    await expect(zerionProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    const spy = stubOk();
    spy.mockClear(); // vi.spyOn 复用同一个 spy,带着上面的历史
    await expect(zerionProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
