import { bypassGatesForTests, resetGatesForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { okxProvider } from "../src";

// okx **刻意没有速率闸**,这个文件就是钉住这件事的 —— 不然下一个人看到别的 provider 都有闸,
// 会顺手补一个上来。
//
// 判据是「有没有多个调用挤同一份额度」:okx 的额度按**账户自己那把 key** 算,而一次
// fetchBalances 只发 1 个请求、不并发。队永远是空的,闸一次都拦不到 —— 那是装饰,不是保护。
// 而且加了还有害:两个账户会被塞进同一个队白白串行化,它们本来花的是各自的额度。
//
// 怎么钉:闸旁路**关掉**(所以如果有闸,它会真的生效),然后连发很多次并断言全部挤在同一刻。
// 有闸的话额度一用完就会出现第二个时刻。

type Ctx = Parameters<typeof okxProvider.fetchBalances>[0];
const ctx = (): Ctx =>
  ({
    account: {
      id: "a1",
      label: "OKX",
      connectorId: "okx",
      creds: { apiKey: "k", secret: "s", passphrase: "p" },
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

describe("okx 没有闸", () => {
  it("连发 20 次,全部在同一刻出去 —— 一次等待都没有", async () => {
    const at: number[] = [];
    const t0 = Date.now();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      at.push(Date.now() - t0);
      return new Response(JSON.stringify({ code: "0", data: [] }), { status: 200 });
    });

    const runs = Promise.all(Array.from({ length: 20 }, () => okxProvider.fetchBalances(ctx())));
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(60_000);
    await runs;

    expect(at).toHaveLength(20);
    expect(new Set(at).size).toBe(1); // 有闸就会有第二个时刻
  });
});
