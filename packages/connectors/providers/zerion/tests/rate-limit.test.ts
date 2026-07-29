import { bypassGatesForTests, resetGatesForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChainIdsCacheForTests, zerionProvider } from "../src";
import chainsFixture from "./fixtures/chains.json";
import positionsFixture from "./fixtures/positions.json";

// 一次 fetchBalances 发 2 个请求,而且是 `Promise.all` **并行**的 —— 本文件钉的就是「并行的那两发
// 也各占一个时隙」。要是哪天有人以为「反正在 Promise.all 里」就绕开闸,6 个账户就是瞬时 12 发,
// 越过免费档 10 RPS 的线。
//
// 用假时钟推进,不真等(p-throttle 用 setTimeout,fake timer 接得住)。

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
function stubFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const body = String(input).includes("/chains") ? chainsFixture : positionsFixture;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  bypassGatesForTests(false);
  resetGatesForTests();
  resetChainIdsCacheForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("速率闸", () => {
  it("并行的两发各占一个时隙 —— 不因为在 Promise.all 里就一起冲出去", async () => {
    stubFetch();
    const at: number[] = [];
    const t0 = Date.now();
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementation(async (input) => {
      at.push(Date.now() - t0);
      const body = String(input).includes("/chains") ? chainsFixture : positionsFixture;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const run = zerionProvider.fetchBalances(ctx());
    await vi.runAllTimersAsync();
    await run;

    // 链清单 + positions 两发。额度是 8 发/窗口,所以这两发都在第一个窗口内 —— 不该被拆开。
    expect(at).toHaveLength(2);
    expect(Math.max(...at)).toBe(0);
  });

  it("超出突发额度之后开始摊开(证明这两发真的走了闸,不是绕过去的)", async () => {
    stubFetch();
    const at: number[] = [];
    const t0 = Date.now();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      at.push(Date.now() - t0);
      const body = String(input).includes("/chains") ? chainsFixture : positionsFixture;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    // 8 个账户并发:链清单缓存还没建起来时它们各问一次,所以是 8 + 8 = 16 发。
    // 额度是 8 发/窗口 → 只有 8 发能在第一个窗口出去,其余必须落到后面的窗口。
    const runs = Promise.all(Array.from({ length: 8 }, () => zerionProvider.fetchBalances(ctx())));
    await vi.runAllTimersAsync();
    await runs;

    expect(at).toHaveLength(16);
    expect(at.filter((t) => t === 0)).toHaveLength(8); // 正好一个窗口的量
    expect(Math.max(...at)).toBeGreaterThan(0); // 剩下的被摊到了后面
  });
});
