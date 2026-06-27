import type { FetchContext } from "@folio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hyperliquidProvider, parseClearinghouseState, providers } from "../src";
import fixture from "./fixtures/clearinghouse-state.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function ctx(overrides: Partial<FetchContext> = {}): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "perp_hyperliquid", label: "HL" },
    creds: { identifier: ADDR },
    globalKeys: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// fixture = schema 忠实的 clearinghouseState(基于官方示例 + 一条空头)。整份解析结果钉成 golden:
// 权益行(唯一带值)+ 每仓位一行(usdValue=0、明细进 meta);字符串字段统一 Number();
// szi 符号 → side(long/short);liquidationPx 可为 null。
describe("parseClearinghouseState (golden)", () => {
  it("maps the recorded response to the expected Balance[]", () => {
    expect(parseClearinghouseState(fixture)).toEqual([
      {
        symbol: "USDC",
        amount: 13109.482328,
        usdValue: 13109.482328,
        source: "hyperliquid",
        kind: "perp",
        meta: {
          role: "equity",
          withdrawable: 13104.514502,
          totalMarginUsed: 4.967826,
          totalNtlPos: 100.02765,
        },
      },
      {
        symbol: "ETH",
        amount: 0.0335,
        usdValue: 0,
        source: "hyperliquid",
        kind: "perp",
        meta: {
          role: "position",
          side: "long",
          entryPx: 2986.3,
          positionValue: 100.02765,
          unrealizedPnl: -0.0134,
          leverage: 20,
          leverageType: "isolated",
          liquidationPx: 2866.26936529,
          marginUsed: 4.967826,
        },
      },
      {
        symbol: "BTC",
        amount: -0.01,
        usdValue: 0,
        source: "hyperliquid",
        kind: "perp",
        meta: {
          role: "position",
          side: "short",
          entryPx: 64000,
          positionValue: 640,
          unrealizedPnl: 12.5,
          leverage: 10,
          leverageType: "cross",
          liquidationPx: null,
          marginUsed: 64,
        },
      },
    ]);
  });

  it("emits only the equity row for an account with no open positions", () => {
    const balances = parseClearinghouseState({
      marginSummary: {
        accountValue: "0.0",
        totalMarginUsed: "0.0",
        totalNtlPos: "0.0",
        totalRawUsd: "0.0",
      },
      assetPositions: [],
      withdrawable: "0.0",
    });
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ symbol: "USDC", amount: 0, usdValue: 0 });
  });

  it("total usdValue equals account equity (positions do not double-count)", () => {
    const total = parseClearinghouseState(fixture).reduce((s, b) => s + b.usdValue, 0);
    expect(total).toBe(13109.482328);
  });
});

describe("hyperliquidProvider.fetchBalances", () => {
  it("POSTs clearinghouseState with the address and parses the response", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    const balances = await hyperliquidProvider.fetchBalances(ctx());
    expect(balances).toHaveLength(3);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/info");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ type: "clearinghouseState", user: ADDR });
  });

  it("throws INVALID_CREDENTIALS on missing/invalid address (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(hyperliquidProvider.fetchBalances(ctx({ creds: {} }))).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    await expect(
      hyperliquidProvider.fetchBalances(ctx({ creds: { identifier: "not-an-address" } })),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps 429 → RATE_LIMITED (retryable, parses Retry-After), 5xx → UPSTREAM_ERROR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
    );
    await expect(hyperliquidProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 3000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    await expect(hyperliquidProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("throws PARSE_ERROR on invalid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(hyperliquidProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
  });

  it("serves accountType perp_hyperliquid and is exported in providers", () => {
    expect(hyperliquidProvider.accountType).toBe("perp_hyperliquid");
    expect(hyperliquidProvider.usesGlobalKeys).toBeUndefined();
    expect(providers).toContain(hyperliquidProvider);
  });
});
