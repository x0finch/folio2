import {
  type CgkCoinId,
  type DefiLlamaCoinId,
  TokenError,
  type TokenRef,
} from "@folio/oracle-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../src/constants";
import { createDefiLlamaProvider } from "../src/provider";
import pricesCurrent from "./fixtures/prices_current.json";

const USER_AGENT_HEADER = "user-agent";
const USDC_KEY = "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const dl = (key: string): TokenRef => ({ source: "defillama", identifier: key as DefiLlamaCoinId });

interface Call {
  url: URL;
  init?: RequestInit;
}
type Reply = { body?: unknown; raw?: string; status?: number; headers?: Record<string, string> };

// mock 全局 fetch(镜像 coingecko provider 测试),记录调用便于断言 url/headers。afterEach 还原。
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

describe("DefiLlama error mapping", () => {
  it("429 → RATE_LIMITED (retryable) with retryAfterMs", async () => {
    mockFetch(() => ({ status: 429, headers: { "retry-after": "30" } }));
    await expect(
      createDefiLlamaProvider().fetchPrices([dl("coingecko:bitcoin")]),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterMs: 30000 });
  });

  it("5xx → UPSTREAM_ERROR (retryable)", async () => {
    mockFetch(() => ({ status: 503 }));
    await expect(
      createDefiLlamaProvider().fetchPrices([dl("coingecko:bitcoin")]),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", retryable: true });
  });

  it("other 4xx → UPSTREAM_ERROR (non-retryable)", async () => {
    mockFetch(() => ({ status: 400 }));
    await expect(
      createDefiLlamaProvider().fetchPrices([dl("coingecko:bitcoin")]),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", retryable: false });
  });

  it("bad JSON → PARSE_ERROR", async () => {
    mockFetch(() => ({ raw: "<<notjson>>" }));
    await expect(
      createDefiLlamaProvider().fetchPrices([dl("coingecko:bitcoin")]),
    ).rejects.toBeInstanceOf(TokenError);
  });

  // 回归:CF Workers fetch 默认不带 UA → 恒注入。
  it("always sends a User-Agent header", async () => {
    const { calls } = mockFetch(() => ({ body: { coins: {} } }));
    await createDefiLlamaProvider().fetchPrices([dl("coingecko:bitcoin")]);
    expect((calls[0].init?.headers as Record<string, string>)[USER_AGENT_HEADER]).toBe(USER_AGENT);
  });
});

describe("fetchPrices", () => {
  it("joins defillama coin keys into the path and parses", async () => {
    const { calls } = mockFetch(() => ({ body: pricesCurrent }));
    const prices = await createDefiLlamaProvider().fetchPrices([
      dl("coingecko:bitcoin"),
      dl(USDC_KEY),
    ]);
    expect(calls[0].url.pathname).toBe(`/prices/current/coingecko:bitcoin,${USDC_KEY}`);
    expect(prices.get("defillama:coingecko:bitcoin")?.unitPrice).toBe(65000);
    expect(prices.get(`defillama:${USDC_KEY}`)?.unitPrice).toBe(1.001);
  });

  it("ignores non-defillama refs; all-filtered → empty map, no request", async () => {
    const { calls } = mockFetch(() => ({ body: { coins: {} } }));
    const cg: TokenRef = { source: "coingecko", identifier: "bitcoin" as CgkCoinId };
    const out = await createDefiLlamaProvider().fetchPrices([cg]);
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("fetchByContract", () => {
  it("translates chain→slug, builds {slug}:{addr} key, parses coin", async () => {
    const { calls } = mockFetch(() => ({ body: pricesCurrent }));
    // chainId 137 → polygon;但 fixture 只含 ethereum key,这里用 ethereum 验命中路径。
    const out = await createDefiLlamaProvider().fetchByContract(
      "ethereum",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    );
    expect(calls[0].url.pathname).toBe(`/prices/current/${USDC_KEY}`); // 地址小写化
    expect(out?.ref).toEqual(dl(USDC_KEY));
    expect(out?.info.symbol).toBe("USDC");
    expect(out?.price.unitPrice).toBe(1.001);
  });

  it("maps EVM chainId + CGK slug aliases to DefiLlama slug", async () => {
    const { calls } = mockFetch(() => ({ body: { coins: {} } }));
    const p = createDefiLlamaProvider();
    await p.fetchByContract("137", "0xAbC");
    await p.fetchByContract("polygon-pos", "0xAbC");
    expect(calls[0].url.pathname).toBe("/prices/current/polygon:0xabc");
    expect(calls[1].url.pathname).toBe("/prices/current/polygon:0xabc");
  });

  it("unknown chain → lowercased slug fallback", async () => {
    const { calls } = mockFetch(() => ({ body: { coins: {} } }));
    await createDefiLlamaProvider().fetchByContract("SomeChain", "0xAbC");
    expect(calls[0].url.pathname).toBe("/prices/current/somechain:0xabc");
  });

  it("coin absent in response → null", async () => {
    mockFetch(() => ({ body: { coins: {} } }));
    const out = await createDefiLlamaProvider().fetchByContract("ethereum", "0xdead");
    expect(out).toBeNull();
  });
});

describe("non-price faces (capability = prices only)", () => {
  it("fetchMarkets / searchTokens → empty, no request", async () => {
    const { calls } = mockFetch(() => ({ body: {} }));
    const p = createDefiLlamaProvider();
    expect(await p.fetchMarkets({ topN: 100 })).toEqual([]);
    expect(await p.searchTokens("btc")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("source tag = defillama", () => {
    expect(createDefiLlamaProvider().source).toBe("defillama");
  });
});
