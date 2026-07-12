import { type CgkCoinId, TokenError, type TokenRef } from "@folio/oracle-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CG_BASE_FREE,
  CG_BASE_PRO,
  HEADER_DEMO,
  HEADER_PRO,
  PER_PAGE_MAX,
  USER_AGENT,
} from "../src/constants";
import { createCoinGeckoProvider } from "../src/provider";

const USER_AGENT_HEADER = "user-agent";
const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });

interface Call {
  url: URL;
  init?: RequestInit;
}

type Reply = { body?: unknown; raw?: string; status?: number; headers?: Record<string, string> };

// mock 全局 fetch(与各 provider 一致),记录每次调用便于断言 url/headers。afterEach 还原。
function mockFetch(handler: (url: URL, callNo: number) => Reply) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    const r = handler(url, calls.length);
    const body = r.raw ?? JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch);
  return { calls };
}

afterEach(() => vi.restoreAllMocks());

function genMarketPage(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `coin-${i}`,
    symbol: `c${i}`,
    name: `Coin ${i}`,
    image: "x",
    current_price: 1,
    market_cap_rank: i + 1,
    price_change_percentage_24h: 0,
    last_updated: "2026-06-29T00:00:00.000Z",
  }));
}

describe("CoinGeckoSource error mapping", () => {
  it("429 → RATE_LIMITED (retryable) with retryAfterMs from header", async () => {
    mockFetch(() => ({ status: 429, headers: { "retry-after": "30" } }));
    const src = createCoinGeckoProvider();
    await expect(src.fetchPrices([cg("bitcoin")])).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 30000,
    });
  });

  it("5xx → UPSTREAM_ERROR (retryable)", async () => {
    mockFetch(() => ({ status: 503 }));
    const src = createCoinGeckoProvider();
    await expect(src.fetchPrices([cg("bitcoin")])).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: true,
    });
  });

  it("other 4xx → UPSTREAM_ERROR (non-retryable)", async () => {
    mockFetch(() => ({ status: 400 }));
    const src = createCoinGeckoProvider();
    await expect(src.fetchPrices([cg("bitcoin")])).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: false,
    });
  });

  it("bad JSON → PARSE_ERROR", async () => {
    mockFetch(() => ({ raw: "<<notjson>>" }));
    const src = createCoinGeckoProvider();
    await expect(src.fetchPrices([cg("bitcoin")])).rejects.toBeInstanceOf(TokenError);
    await expect(src.fetchPrices([cg("bitcoin")])).rejects.toMatchObject({ code: "PARSE_ERROR" });
  });
});

describe("CoinGeckoSource config", () => {
  it("free base + demo header when key given", async () => {
    const { calls } = mockFetch(() => ({ body: {} }));
    await createCoinGeckoProvider({ apiKey: "k" }).fetchPrices([cg("bitcoin")]);
    expect(calls[0].url.toString().startsWith(CG_BASE_FREE)).toBe(true);
    expect((calls[0].init?.headers as Record<string, string>)[HEADER_DEMO]).toBe("k");
  });

  it("pro base + pro header when pro", async () => {
    const { calls } = mockFetch(() => ({ body: {} }));
    await createCoinGeckoProvider({ apiKey: "k", pro: true }).fetchPrices([cg("bitcoin")]);
    expect(calls[0].url.toString().startsWith(CG_BASE_PRO)).toBe(true);
    expect((calls[0].init?.headers as Record<string, string>)[HEADER_PRO]).toBe("k");
  });

  // 回归:CGK 的 Cloudflare WAF 对无 User-Agent 的请求返 403(CF Workers fetch 默认不带 UA)。
  it("always sends a User-Agent header (keyless too)", async () => {
    const { calls } = mockFetch(() => ({ body: {} }));
    await createCoinGeckoProvider().fetchPrices([cg("bitcoin")]);
    expect((calls[0].init?.headers as Record<string, string>)[USER_AGENT_HEADER]).toBe(USER_AGENT);
  });
});

describe("fetchMarkets", () => {
  it("paginates until a short page, then slices to topN", async () => {
    const { calls } = mockFetch((_url, n) => ({
      body: n === 1 ? genMarketPage(PER_PAGE_MAX) : genMarketPage(10),
    }));
    const src = createCoinGeckoProvider();
    const rows = await src.fetchMarkets({ topN: 300 });
    expect(calls).toHaveLength(2);
    expect(rows).toHaveLength(PER_PAGE_MAX + 10);
    // query params on page 1
    expect(calls[0].url.searchParams.get("vs_currency")).toBe("usd");
    expect(calls[0].url.searchParams.get("order")).toBe("market_cap_desc");
    expect(calls[0].url.searchParams.get("per_page")).toBe(String(PER_PAGE_MAX));
    expect(calls[0].url.searchParams.get("page")).toBe("1");
    expect(calls[0].url.searchParams.get("price_change_percentage")).toBe("24h,7d,30d");
    expect(calls[1].url.searchParams.get("page")).toBe("2");
  });

  it("single page when topN small (no extra request)", async () => {
    const { calls } = mockFetch(() => ({ body: genMarketPage(5) }));
    const src = createCoinGeckoProvider();
    const rows = await src.fetchMarkets({ topN: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get("per_page")).toBe("50");
    expect(rows).toHaveLength(5);
  });
});

describe("fetchPrices", () => {
  it("joins coingecko ids and parses the response", async () => {
    const { calls } = mockFetch(() => ({
      body: { bitcoin: { usd: 65000, usd_24h_change: 1.5, last_updated_at: 1782000000 } },
    }));
    const src = createCoinGeckoProvider();
    const prices = await src.fetchPrices([cg("bitcoin"), cg("ethereum")]);
    expect(calls[0].url.searchParams.get("ids")).toBe("bitcoin,ethereum");
    expect(prices.get("coingecko:bitcoin")?.unitPrice).toBe(65000);
  });

  it("no refs → empty map, no request", async () => {
    const { calls } = mockFetch(() => ({ body: {} }));
    const src = createCoinGeckoProvider();
    expect((await src.fetchPrices([])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("searchTokens", () => {
  it("sends query and parses coins[] → TokenInfo[]", async () => {
    const { calls } = mockFetch(() => ({
      body: { coins: [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", large: "L" }] },
    }));
    const out = await createCoinGeckoProvider().searchTokens("btc");
    expect(calls[0].url.pathname.endsWith("/search")).toBe(true);
    expect(calls[0].url.searchParams.get("query")).toBe("btc");
    expect(out).toEqual([{ ref: cg("bitcoin"), symbol: "BTC", name: "Bitcoin", logo: "L" }]);
  });

  it("blank query → [] without a request", async () => {
    const { calls } = mockFetch(() => ({ body: { coins: [] } }));
    expect(await createCoinGeckoProvider().searchTokens("  ")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// fetchByContract internally maps chain→platform (CGK's asset_platform slug) via a memoized
// /asset_platforms fetch, then hits the per-contract endpoint with the resolved platform.
const PLATFORMS = [
  { id: "ethereum", chain_identifier: 1 },
  { id: "polygon-pos", chain_identifier: 137 },
];
const USDC_CONTRACT_BODY = {
  id: "usd-coin",
  symbol: "usdc",
  name: "USDC",
  image: { large: "L" },
  market_cap_rank: 6,
  market_data: { current_price: { usd: 1.001 }, price_change_percentage_24h: 0.05 },
  last_updated: "2026-06-29T00:00:00.000Z",
};

// route by path: /asset_platforms → PLATFORMS, contract path → contract body
function contractMock() {
  return mockFetch((url) =>
    url.pathname.endsWith("/asset_platforms") ? { body: PLATFORMS } : { body: USDC_CONTRACT_BODY },
  );
}

describe("fetchByContract", () => {
  it("maps chain→platform internally, then resolves; 200 → {ref, info, price}", async () => {
    const { calls } = contractMock();
    const out = await createCoinGeckoProvider().fetchByContract("ethereum", "0xABC");
    expect(out?.ref).toEqual(cg("usd-coin"));
    expect(out?.info.logo).toBe("L");
    expect(out?.price.unitPrice).toBe(1.001);
    // first call = asset_platforms, second = per-contract with resolved platform + lowercased addr
    expect(calls[0].url.pathname.endsWith("/asset_platforms")).toBe(true);
    expect(calls[1].url.pathname).toBe("/api/v3/coins/ethereum/contract/0xabc");
  });

  it("translates our chain slug to CGK platform slug (polygon → polygon-pos)", async () => {
    const { calls } = contractMock();
    await createCoinGeckoProvider().fetchByContract("polygon-pos", "0xABC");
    expect(calls[1].url.pathname).toBe("/api/v3/coins/polygon-pos/contract/0xabc");
  });

  it("chain not in asset_platforms → null (no per-contract call)", async () => {
    const { calls } = contractMock();
    const out = await createCoinGeckoProvider().fetchByContract("unknownchain", "0x1");
    expect(out).toBeNull();
    expect(calls).toHaveLength(1); // only asset_platforms
  });

  it("per-contract 404 → null (not thrown)", async () => {
    mockFetch((url) =>
      url.pathname.endsWith("/asset_platforms")
        ? { body: PLATFORMS }
        : { status: 404, body: { error: "not found" } },
    );
    const out = await createCoinGeckoProvider().fetchByContract("ethereum", "0xdead");
    expect(out).toBeNull();
  });
});
