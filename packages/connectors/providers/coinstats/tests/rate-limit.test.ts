import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoinstatsProvider } from "../src";
import { COINSTATS_API_KEY } from "../src/constants";
import solanaFixture from "./fixtures/solana.json";

// **一把 key 服务三个 connector**(sui / cosmos / solana),所以它们必须共享同一个队 ——
// 花的是同一份额度。这是本文件要钉的东西:换成每个 provider 一个队,三条链一起同步时
// 就是三倍超速,而免费档只有 2 请求/秒。

type Ctx = Parameters<ReturnType<typeof createCoinstatsProvider>["fetchBalances"]>[0];
const ctx = (): Ctx =>
  ({
    account: { id: "a1", label: "W", connectorId: "solana", creds: { address: "abc" } },
    creds: { [COINSTATS_API_KEY]: "k" },
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

// 断言按**条数**、在受控时钟步进下数,不看 Date.now 分组 —— 后者会被 header 里的异步在时钟推进
// 之间切开,偶发 flaky(实测 okx no-gate 那条)。`advanceTimersByTimeAsync(0)` 只冲微任务不推进时钟:
// 一个窗口能出去的都出去、被闸住的卡在 setTimeout(>0),count 就是那个窗口的量。
describe("三条链共享一个队", () => {
  // 每次新建 Response(body 只能读一次,不能 mockResolvedValue 复用同一个实例)。
  const stubFetch = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify(solanaFixture), { status: 200 }));

  // 三个不同的 provider 实例(部署里三个 connector 各持一个)。**每条链各自 `runPromise`,
  // 不是包成一个 `Effect.all`** —— 要测的正是「三个互不相干的调用者挤同一份额度」,
  // 合成一个 effect 会把它们变成同一个 fiber 里的顺序执行,那就测不到闸了。
  const runThree = () =>
    Promise.all(
      ["solana", "sui", "cosmos"].map((chain) =>
        Effect.runPromise(createCoinstatsProvider(chain).fetchBalances(ctx())),
      ),
    );

  it("三条链各取一次 → 被摊开,不是各自满速", async () => {
    const fetchSpy = stubFetch();
    const runs = runThree(); // 三个不同 provider 实例(部署里三个 connector 各持一个)
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // 额度 2 发/窗口 → 前两发同窗口
    await vi.runAllTimersAsync();
    await runs;
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 第三发被摊到下一窗口 → 队是共享的
  });

  it("反面:如果队没共享,三发就会一起出去 —— 这条钉住不是那样", async () => {
    const fetchSpy = stubFetch();
    const runs = runThree();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).not.toHaveBeenCalledTimes(3); // 共享队 → 窗口 0 只放 2 发,不是 3
    await vi.runAllTimersAsync();
    await runs;
  });
});
