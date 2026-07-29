import { bypassGatesForTests, resetGatesForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binanceProvider } from "../src";
import { ACCOUNT_PATH, TICKER_PRICE_PATH } from "../src/constants";
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
  bypassGatesForTests(false);
  resetGatesForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("只有公开端点过闸", () => {
  // **断言的是对比,不是具体时刻。** fetchBalances 是两段的(先签名、再行情),而假时钟推进时
  // 后半段可能还没入队 —— 于是「第几发在第几毫秒」会被推进粒度污染。真正的不变量是:
  // 签名那批全在同一刻出去(没有闸),行情那批被分散到多个时刻(有闸)。
  it("签名那批挤在同一刻,行情那批被分散 —— 闸只作用在后者", async () => {
    const calls = stubFetch();
    // 额度 6 发/窗口,这里跑 12 个账户 → 行情端点一定跨窗口。
    const runs = Promise.all(
      Array.from({ length: 12 }, () => binanceProvider.fetchBalances(ctx())),
    );
    await drain();
    await runs;

    const signedAt = calls.filter((c) => c.path === ACCOUNT_PATH).map((c) => c.at);
    const tickerAt = calls.filter((c) => c.path === TICKER_PRICE_PATH).map((c) => c.at);
    expect(signedAt).toHaveLength(12);
    expect(tickerAt).toHaveLength(12);

    // 签名端点没有闸 → 12 发同一刻
    expect(new Set(signedAt).size).toBe(1);
    // 行情端点有闸 → 分散到多个刻,而且每个窗口最多 6 发
    expect(new Set(tickerAt).size).toBeGreaterThan(1);
    for (const t of new Set(tickerAt)) {
      expect(tickerAt.filter((x) => x === t).length).toBeLessThanOrEqual(6);
    }
  });
});
