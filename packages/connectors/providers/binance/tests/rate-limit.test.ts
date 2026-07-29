import { resetLimitsForTests, setSleepForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binanceProvider } from "../src";
import { ACCOUNT_PATH, TICKER_PRICE_PATH } from "../src/constants";
import account from "./fixtures/account.json";
import prices from "./fixtures/prices.json";

// 速率闸**只装在公开端点上**。这个区分是本文件唯一要钉的东西:binance 的额度按 IP 算,
// 公开的全市场行情是所有账户、所有用户共花一份;签名的 /account 一个账户只发一次、不并发,
// 装闸拦不到任何东西(桶永远是满的),所以刻意不装。

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

setSleepForTests(async () => {});
beforeEach(() => resetLimitsForTests());
afterEach(() => vi.restoreAllMocks());

// 按路径应答并记录出网路径。tickerStatus 让「行情端点限流」单独可控。
function stubFetch(opts: { tickerStatus?: number } = {}) {
  const paths: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === TICKER_PRICE_PATH) {
      return opts.tickerStatus
        ? new Response("", { status: opts.tickerStatus })
        : new Response(
            JSON.stringify(
              prices
                ? Object.entries(prices).map(([symbol, price]) => ({
                    symbol,
                    price: String(price),
                  }))
                : [],
            ),
          );
    }
    return new Response(JSON.stringify(account));
  });
  return paths;
}

describe("公开端点撞限流之后", () => {
  it("进冷却:下一轮**签名端点照发**,行情端点不出网 —— 证明闸只管公开那一发", async () => {
    const first = stubFetch({ tickerStatus: 429 });
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(first).toEqual([ACCOUNT_PATH, TICKER_PRICE_PATH]);

    // 第二轮:/account 仍然出网(它没有闸),而行情端点被冷却挡住,压根不出网。
    const second = stubFetch();
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(second).toEqual([ACCOUNT_PATH]);
  });

  it("418(收到 429 还继续打换来的封 IP)同样进冷却", async () => {
    stubFetch({ tickerStatus: 418 });
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const second = stubFetch();
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(second).toEqual([ACCOUNT_PATH]);
  });
});

describe("突发额度", () => {
  it("容量等于 sync 的并发度 → 常见情形(6 个账户各一发)一次都不用等", async () => {
    const waits: number[] = [];
    setSleepForTests(async (ms) => void waits.push(ms));
    stubFetch();
    for (let i = 0; i < 6; i++) await binanceProvider.fetchBalances(ctx());
    expect(waits).toEqual([]);
    // 第 7 发才开始被摊开
    await binanceProvider.fetchBalances(ctx());
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    setSleepForTests(async () => {});
  });
});

describe("签名端点的 429 **不该**污染公开端点的闸", () => {
  it("/account 撞 429 → 公开端点的冷却没被写上,下一轮行情照发", async () => {
    // 这是「只给公开端点装闸」的另一半:闸和冷却都只挂在公开那份额度上。要是把 /account 的 429
    // 也写进 `binance:public` 的冷却,一个账户的 key 出问题就会连累所有账户的行情取数。
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      return url.pathname === ACCOUNT_PATH
        ? new Response("", { status: 429 })
        : new Response(JSON.stringify([]));
    });
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(paths).toEqual([ACCOUNT_PATH]); // 签名那发就挂了,没走到行情

    // 下一轮:公开端点没有被冷却,照样出网。
    const next = stubFetch();
    await binanceProvider.fetchBalances(ctx());
    expect(next).toEqual([ACCOUNT_PATH, TICKER_PRICE_PATH]);
  });
});
