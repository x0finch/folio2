import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CoinGeckoConfig,
  type CoinGeckoError,
  createCoinGeckoClient,
  HEADER_DEMO,
  HEADER_PRO,
  USER_AGENT,
} from "../src/index";

// 每个用例都从干净的闸和冷却标记出发,且 sleep 即时 —— 否则限速闸会让这套测试**真的等**
// (无 key 档是 10 次/分钟,一发就是 6 秒),而上一个用例写下的冷却还会漏给下一个。
// 建客户端一律走这个工厂,别直接 createCoinGeckoClient。
const newClient = (config: CoinGeckoConfig = {}) =>
  createCoinGeckoClient({ ...config, sleep: async () => {} });

// 限速闸旁路:这个文件测的不是限频。闸的行为在 @folio/shared 的单测里用假时钟验过,
// 这里让它直接放行 —— 否则每个用例都要按窗口真等。
bypassRateLimitsForTests(true);

beforeEach(() => resetRateLimitsForTests());

function mockFetch(res: Partial<Response> & { json?: () => Promise<unknown> }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(res as Response);
}
function ok(body: unknown): Partial<Response> {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() };
}
async function grabErr(p: Promise<unknown>): Promise<CoinGeckoError> {
  try {
    await p;
    throw new Error("expected to throw");
  } catch (e) {
    return e as CoinGeckoError;
  }
}
const urlOf = (f: ReturnType<typeof mockFetch>): URL => f.mock.calls[0][0] as URL;
const initOf = (f: ReturnType<typeof mockFetch>): RequestInit => f.mock.calls[0][1] as RequestInit;
afterEach(() => vi.restoreAllMocks());

describe("createCoinGeckoClient · 传输(头/基址,以 assetPlatforms 为例)", () => {
  it("注入 User-Agent 头(CF WAF 修复)", async () => {
    const f = mockFetch(ok([]));
    await newClient().assetPlatforms();
    expect((initOf(f).headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
  });

  it("demo key → demo 头 + free 基址", async () => {
    const f = mockFetch(ok([]));
    await newClient({ apiKey: "k" }).assetPlatforms();
    expect(urlOf(f).toString()).toContain("api.coingecko.com/api/v3");
    expect(initOf(f).headers).toMatchObject({ [HEADER_DEMO]: "k" });
  });

  it("pro key → pro 头 + pro 基址", async () => {
    const f = mockFetch(ok([]));
    await newClient({ apiKey: "k", pro: true }).assetPlatforms();
    expect(urlOf(f).toString()).toContain("pro-api.coingecko.com");
    expect(initOf(f).headers).toMatchObject({ [HEADER_PRO]: "k" });
  });
});

describe("createCoinGeckoClient · 方法(URL/参数拼装 + 返回)", () => {
  it("assetPlatforms → GET /asset_platforms,返回数组", async () => {
    const body = [{ id: "ethereum", chain_identifier: 1 }];
    const f = mockFetch(ok(body));
    expect(await newClient().assetPlatforms()).toEqual(body);
    expect(urlOf(f).pathname).toBe("/api/v3/asset_platforms");
  });

  it("coinsMarkets → /coins/markets 带全部参数(跳过 undefined)", async () => {
    const f = mockFetch(ok([]));
    await newClient().coinsMarkets({
      vsCurrency: "usd",
      order: "market_cap_desc",
      perPage: 250,
      page: 2,
      priceChangePercentage: "24h,7d",
    });
    const u = urlOf(f);
    expect(u.pathname).toBe("/api/v3/coins/markets");
    expect(u.searchParams.get("vs_currency")).toBe("usd");
    expect(u.searchParams.get("per_page")).toBe("250");
    expect(u.searchParams.get("page")).toBe("2");
    expect(u.searchParams.get("price_change_percentage")).toBe("24h,7d");
  });

  it("simplePrice → ids/vs_currencies join,bool → 'true'", async () => {
    const f = mockFetch(ok({ bitcoin: { usd: 1 } }));
    await newClient().simplePrice({
      ids: ["bitcoin", "ethereum"],
      vsCurrencies: ["usd"],
      include24hrChange: true,
      includeLastUpdatedAt: true,
    });
    const u = urlOf(f);
    expect(u.searchParams.get("ids")).toBe("bitcoin,ethereum");
    expect(u.searchParams.get("vs_currencies")).toBe("usd");
    expect(u.searchParams.get("include_24hr_change")).toBe("true");
    expect(u.searchParams.get("include_last_updated_at")).toBe("true");
  });

  it("simplePrice → 未开的 bool 不出现在 query", async () => {
    const f = mockFetch(ok({}));
    await newClient().simplePrice({ ids: ["btc"], vsCurrencies: ["usd"] });
    expect(urlOf(f).searchParams.has("include_24hr_change")).toBe(false);
  });

  it("coinsMarketChartRange → /coins/{id}/market_chart/range 带 vs_currency/from/to;返回 prices 对(ms)", async () => {
    // CGK 返回的 prices 时间戳是**毫秒**(from/to 查询参数是秒)—— client 原样透传。
    const body = {
      prices: [
        [1_600_000_000_000, 60000],
        [1_600_086_400_000, 65000],
      ],
      market_caps: [[1_600_000_000_000, 1e12]],
      total_volumes: [[1_600_000_000_000, 3e10]],
    };
    const f = mockFetch(ok(body));
    const out = await newClient().coinsMarketChartRange({
      id: "bitcoin",
      vsCurrency: "usd",
      fromSec: 1_600_000_000,
      toSec: 1_600_086_400,
    });
    expect(out).toEqual([
      [1_600_000_000_000, 60000],
      [1_600_086_400_000, 65000],
    ]);
    const u = urlOf(f);
    expect(u.pathname).toBe("/api/v3/coins/bitcoin/market_chart/range");
    expect(u.searchParams.get("vs_currency")).toBe("usd");
    expect(u.searchParams.get("from")).toBe("1600000000");
    expect(u.searchParams.get("to")).toBe("1600086400");
  });

  it("search → /search?query=", async () => {
    const f = mockFetch(ok({ coins: [] }));
    await newClient().search("btc");
    expect(urlOf(f).pathname).toBe("/api/v3/search");
    expect(urlOf(f).searchParams.get("query")).toBe("btc");
  });

  it("coinContract → path 含 platform + 小写 address;命中返回对象", async () => {
    const body = { id: "usd-coin" };
    const f = mockFetch(ok(body));
    expect(await newClient().coinContract("ethereum", "0xABCdef")).toEqual(body);
    expect(urlOf(f).pathname).toBe("/api/v3/coins/ethereum/contract/0xabcdef");
  });

  it("exchange / derivativesExchange → 对应 path", async () => {
    const f1 = mockFetch(ok({ name: "Binance" }));
    await newClient().exchange("binance");
    expect(urlOf(f1).pathname).toBe("/api/v3/exchanges/binance");
    vi.restoreAllMocks();
    const f2 = mockFetch(ok({ name: "Hyperliquid" }));
    await newClient().derivativesExchange("hyperliquid");
    expect(urlOf(f2).pathname).toBe("/api/v3/derivatives/exchanges/hyperliquid");
  });

  it("exchangeRates → GET /exchange_rates,返回 { rates }", async () => {
    const body = { rates: { usd: { value: 100000, type: "fiat" }, eur: { value: 92000 } } };
    const f = mockFetch(ok(body));
    expect(await newClient().exchangeRates()).toEqual(body);
    expect(urlOf(f).pathname).toBe("/api/v3/exchange_rates");
  });
});

describe("createCoinGeckoClient · 404 → null(仅可空方法)", () => {
  it("coinContract / exchange / derivativesExchange 404 → null", async () => {
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect(await newClient().coinContract("ethereum", "0x0")).toBeNull();
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect(await newClient().exchange("nope")).toBeNull();
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect(await newClient().derivativesExchange("nope")).toBeNull();
  });
});

describe("createCoinGeckoClient · 错误映射(以 assetPlatforms 触发)", () => {
  it("429 → RATE_LIMITED,带 retryAfterMs", async () => {
    mockFetch({ ok: false, status: 429, headers: new Headers({ "retry-after": "30" }) });
    const err = await grabErr(newClient().assetPlatforms());
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30000);
  });

  it("5xx → UPSTREAM_ERROR retryable;网络异常 → 同", async () => {
    mockFetch({ ok: false, status: 502, headers: new Headers() });
    const a = await grabErr(newClient().assetPlatforms());
    expect(a.code).toBe("UPSTREAM_ERROR");
    expect(a.retryable).toBe(true);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const b = await grabErr(newClient().assetPlatforms());
    expect(b.code).toBe("UPSTREAM_ERROR");
    expect(b.retryable).toBe(true);
  });

  it("404 无 notFoundAsNull(列表端点)→ UPSTREAM_ERROR", async () => {
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect((await grabErr(newClient().assetPlatforms())).code).toBe("UPSTREAM_ERROR");
  });

  it("坏 JSON → PARSE_ERROR", async () => {
    mockFetch({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new Error("bad");
      },
    });
    expect((await grabErr(newClient().assetPlatforms())).code).toBe("PARSE_ERROR");
  });

  it("列表端点非数组 / simplePrice 非对象 → PARSE_ERROR", async () => {
    mockFetch(ok({ not: "array" }));
    expect((await grabErr(newClient().assetPlatforms())).code).toBe("PARSE_ERROR");
    mockFetch(ok(null));
    expect(
      (await grabErr(newClient().simplePrice({ ids: ["x"], vsCurrencies: ["usd"] }))).code,
    ).toBe("PARSE_ERROR");
  });

  it("coinsMarketChartRange 非对象 / 缺 prices 数组 → PARSE_ERROR", async () => {
    const params = { id: "bitcoin", vsCurrency: "usd", fromSec: 1, toSec: 2 };
    mockFetch(ok(null));
    expect((await grabErr(newClient().coinsMarketChartRange(params))).code).toBe("PARSE_ERROR");
    mockFetch(ok({ market_caps: [] })); // 缺 prices
    expect((await grabErr(newClient().coinsMarketChartRange(params))).code).toBe("PARSE_ERROR");
    mockFetch(ok({ prices: "nope" })); // prices 非数组
    expect((await grabErr(newClient().coinsMarketChartRange(params))).code).toBe("PARSE_ERROR");
  });
});

// `parseRetryAfter` 已随 http.ts 一起删掉 —— 解析 Retry-After 现在是 @folio/shared 的活,
// 那三种形态(纯秒数 / HTTP-date / 垃圾值)在它的 tests/http.test.ts 里覆盖。
