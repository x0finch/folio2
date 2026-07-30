import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binanceProvider } from "../src";
import { ACCOUNT_PATH, TICKER_PRICE_PATH, TICKER_RATE_LIMIT_BURST } from "../src/constants";
import account from "./fixtures/account.json";
import prices from "./fixtures/prices.json";

// 速率闸**只装在公开端点上**,这是本文件唯一要钉的东西:binance 的额度按 IP 算,公开的全市场
// 行情是所有账户、所有用户共花一份;签名的 /account 一个账户只发一次、不并发,装闸拦不到任何
// 东西(队永远是空的),所以刻意不装 —— 而且装了还有害,会把两个互不相干的账户排成一队。

type Ctx = Parameters<typeof binanceProvider.fetchBalances>[0];
const ctx = (): Ctx =>
  ({
    account: {
      id: "a1",
      label: "Binance",
      connectorId: "binance",
      creds: { apiKey: "k", secret: "s" },
    },
    creds: {},
  }) as unknown as Ctx;

const tickerBody = JSON.stringify(
  Object.entries(prices).map(([symbol, price]) => ({ symbol, price: String(price) })),
);

// 记录每次出网的 (路径, 时刻)。
function stubFetch() {
  const calls: Array<{ path: string; at: number }> = [];
  const t0 = Date.now();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, at: Date.now() - t0 });
    return new Response(path === TICKER_PRICE_PATH ? tickerBody : JSON.stringify(account));
  });
  return calls;
}

// fetchBalances 是两段的(先签名、再行情),行情那批要等签名的 promise 落地才入队 ——
// 单次 runAllTimersAsync 可能在它们入队之前就把定时器排空了。反复推进直到全部落定。
const drain = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(20_000);
};

beforeEach(() => {
  bypassRateLimitsForTests(false);
  resetRateLimitsForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("只有公开端点过闸", () => {
  // **断言的是个数,不是时刻。** 时刻分不开两种「被拉开」:闸拉开的,和假时钟推进拉开的
  // (fetchBalances 里签名那步要过一次异步 HMAC,推进时它可能还没落地)。所以改成:
  // 先只冲微任务、**一点时间都不推**,这时出去了几个就是「不用等就能出去的有几个」。
  //   · 签名端点没有闸 → 12 个全出去
  //   · 行情端点有闸 → 只出去一个窗口的量(6 个),其余卡在闸上
  // 然后再推时间,其余才出来。
  const flushMicrotasks = async () => {
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
  };

  it("不推时间时:签名 12 发全出去,行情只出去一个窗口的量", async () => {
    const calls = stubFetch();
    const runs = Promise.all(
      Array.from({ length: 12 }, () => binanceProvider.fetchBalances(ctx())),
    );
    await flushMicrotasks();

    const countOf = (path: string) => calls.filter((c) => c.path === path).length;
    expect(countOf(ACCOUNT_PATH)).toBe(12); // 没有闸
    expect(countOf(TICKER_PRICE_PATH)).toBe(TICKER_RATE_LIMIT_BURST); // 有闸,正好一个窗口

    // 推进时间之后,剩下的行情请求才陆续出去。
    await drain();
    await runs;
    expect(countOf(TICKER_PRICE_PATH)).toBe(12);
  });
});
