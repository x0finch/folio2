import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CoinGeckoError,
  createCoinGeckoClient,
  HEADER_DEMO,
  HEADER_PRO,
  parseRetryAfter,
  USER_AGENT,
} from "../src/index";

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
    await createCoinGeckoClient().assetPlatforms();
    expect((initOf(f).headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
  });

  it("demo key → demo 头 + free 基址", async () => {
    const f = mockFetch(ok([]));
    await createCoinGeckoClient({ apiKey: "k" }).assetPlatforms();
    expect(urlOf(f).toString()).toContain("api.coingecko.com/api/v3");
    expect(initOf(f).headers).toMatchObject({ [HEADER_DEMO]: "k" });
  });

  it("pro key → pro 头 + pro 基址", async () => {
    const f = mockFetch(ok([]));
    await createCoinGeckoClient({ apiKey: "k", pro: true }).assetPlatforms();
    expect(urlOf(f).toString()).toContain("pro-api.coingecko.com");
    expect(initOf(f).headers).toMatchObject({ [HEADER_PRO]: "k" });
  });
});

describe("createCoinGeckoClient · 方法(URL/参数拼装 + 返回)", () => {
  it("assetPlatforms → GET /asset_platforms,返回数组", async () => {
    const body = [{ id: "ethereum", chain_identifier: 1 }];
    const f = mockFetch(ok(body));
    expect(await createCoinGeckoClient().assetPlatforms()).toEqual(body);
    expect(urlOf(f).pathname).toBe("/api/v3/asset_platforms");
  });

  it("coinsMarkets → /coins/markets 带全部参数(跳过 undefined)", async () => {
    const f = mockFetch(ok([]));
    await createCoinGeckoClient().coinsMarkets({
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
    await createCoinGeckoClient().simplePrice({
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
    await createCoinGeckoClient().simplePrice({ ids: ["btc"], vsCurrencies: ["usd"] });
    expect(urlOf(f).searchParams.has("include_24hr_change")).toBe(false);
  });

  it("search → /search?query=", async () => {
    const f = mockFetch(ok({ coins: [] }));
    await createCoinGeckoClient().search("btc");
    expect(urlOf(f).pathname).toBe("/api/v3/search");
    expect(urlOf(f).searchParams.get("query")).toBe("btc");
  });

  it("coinContract → path 含 platform + 小写 address;命中返回对象", async () => {
    const body = { id: "usd-coin" };
    const f = mockFetch(ok(body));
    expect(await createCoinGeckoClient().coinContract("ethereum", "0xABCdef")).toEqual(body);
    expect(urlOf(f).pathname).toBe("/api/v3/coins/ethereum/contract/0xabcdef");
  });

  it("exchange / derivativesExchange → 对应 path", async () => {
    const f1 = mockFetch(ok({ name: "Binance" }));
    await createCoinGeckoClient().exchange("binance");
    expect(urlOf(f1).pathname).toBe("/api/v3/exchanges/binance");
    vi.restoreAllMocks();
    const f2 = mockFetch(ok({ name: "Hyperliquid" }));
    await createCoinGeckoClient().derivativesExchange("hyperliquid");
    expect(urlOf(f2).pathname).toBe("/api/v3/derivatives/exchanges/hyperliquid");
  });
});

describe("createCoinGeckoClient · 404 → null(仅可空方法)", () => {
  it("coinContract / exchange / derivativesExchange 404 → null", async () => {
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect(await createCoinGeckoClient().coinContract("ethereum", "0x0")).toBeNull();
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect(await createCoinGeckoClient().exchange("nope")).toBeNull();
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect(await createCoinGeckoClient().derivativesExchange("nope")).toBeNull();
  });
});

describe("createCoinGeckoClient · 错误映射(以 assetPlatforms 触发)", () => {
  it("429 → RATE_LIMITED,带 retryAfterMs", async () => {
    mockFetch({ ok: false, status: 429, headers: new Headers({ "retry-after": "30" }) });
    const err = await grabErr(createCoinGeckoClient().assetPlatforms());
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30000);
  });

  it("5xx → UPSTREAM_ERROR retryable;网络异常 → 同", async () => {
    mockFetch({ ok: false, status: 502, headers: new Headers() });
    const a = await grabErr(createCoinGeckoClient().assetPlatforms());
    expect(a.code).toBe("UPSTREAM_ERROR");
    expect(a.retryable).toBe(true);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const b = await grabErr(createCoinGeckoClient().assetPlatforms());
    expect(b.code).toBe("UPSTREAM_ERROR");
    expect(b.retryable).toBe(true);
  });

  it("404 无 notFoundAsNull(列表端点)→ UPSTREAM_ERROR", async () => {
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect((await grabErr(createCoinGeckoClient().assetPlatforms())).code).toBe("UPSTREAM_ERROR");
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
    expect((await grabErr(createCoinGeckoClient().assetPlatforms())).code).toBe("PARSE_ERROR");
  });

  it("列表端点非数组 / simplePrice 非对象 → PARSE_ERROR", async () => {
    mockFetch(ok({ not: "array" }));
    expect((await grabErr(createCoinGeckoClient().assetPlatforms())).code).toBe("PARSE_ERROR");
    mockFetch(ok(null));
    expect(
      (await grabErr(createCoinGeckoClient().simplePrice({ ids: ["x"], vsCurrencies: ["usd"] })))
        .code,
    ).toBe("PARSE_ERROR");
  });
});

describe("parseRetryAfter", () => {
  it("纯秒数 → ms", () => expect(parseRetryAfter("30")).toBe(30000));
  it("HTTP-date → 相对 ms", () => {
    const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", at - 5000)).toBe(5000);
  });
  it("缺失/坏值 → undefined", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});
