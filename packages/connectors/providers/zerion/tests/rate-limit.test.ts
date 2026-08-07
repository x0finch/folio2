import type { ConnectorError } from "@folio/connectors-basic";
import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChainIdsCacheForTests, zerionProvider } from "../src";
import chainsFixture from "./fixtures/chains.json";
import positionsFixture from "./fixtures/positions.json";

// 契约的出口是 Effect(ADR 0035)。把它接回 vitest 的 async 断言:
// `run` 拿成功值;`failing` 拿**错误值本身** —— 不用 `.rejects`,因为 `runPromise` 抛的是包了
// 一层的 `FiberFailure`,`toMatchObject` 看不见里面的 `_tag`。
const run = <A>(effect: Effect.Effect<A, ConnectorError>): Promise<A> => Effect.runPromise(effect);

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
  bypassRateLimitsForTests(false);
  resetRateLimitsForTests();
  resetChainIdsCacheForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("速率闸", () => {
  // 断言按**条数**、在受控时钟步进下数,不看 Date.now 分组 —— 后者会被 header 里的异步在时钟推进
  // 之间切开,偶发 flaky(实测 okx no-gate 那条)。`advanceTimersByTimeAsync(0)` 只冲微任务不推进时钟:
  // 一个窗口能出去的都出去、被闸住的卡在 setTimeout(>0),count 就是那个窗口的量。
  it("并行的两发各占一个时隙 —— 不因为在 Promise.all 里就一起冲出去", async () => {
    const fetchSpy = stubFetch();
    const pending = run(zerionProvider.fetchBalances(ctx()));
    await vi.advanceTimersByTimeAsync(0);
    // 链清单 + positions 两发,额度 8 发/窗口 → 两发都在第一个窗口内,t=0 就都出去了。
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    await pending;
  });

  it("超出突发额度之后开始摊开(证明这两发真的走了闸,不是绕过去的)", async () => {
    const fetchSpy = stubFetch();
    // 8 个账户并发:链清单缓存还没建起来时它们各问一次,所以是 8 + 8 = 16 发。
    // 额度是 8 发/窗口 → 只有 8 发能在第一个窗口出去,其余必须落到后面的窗口。
    const runs = Promise.all(
      Array.from({ length: 8 }, () => run(zerionProvider.fetchBalances(ctx()))),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(8); // 正好一个窗口的量
    await vi.runAllTimersAsync();
    await runs;
    expect(fetchSpy).toHaveBeenCalledTimes(16); // 剩下 8 发被摊到后面窗口,最终全走
  });
});
