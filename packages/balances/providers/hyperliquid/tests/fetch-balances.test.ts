import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hyperliquidProvider, parseClearinghouseState, providers } from "../src";
import fixture from "./fixtures/clearinghouse-state.json";
import expected from "./fixtures/expected-balances.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function ctx(overrides: Partial<FetchContext> = {}): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "perp_hyperliquid", label: "HL" },
    creds: { identifier: ADDR },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// 两份 fixture 一一对应:clearinghouse-state.json(schema 忠实的响应,基于官方示例 + 一条空头)→
// expected-balances.json(解析后的期望值,固化逐一对比)。覆盖:权益行(唯一带值)+ 每仓位一行
// (value=0、明细进 meta);字符串字段统一 Number();szi 符号→side(long/short);liquidationPx 可为 null。
describe("parseClearinghouseState (golden: fixture in → fixture out)", () => {
  it("maps the recorded response to expected-balances", () => {
    expect(parseClearinghouseState(fixture)).toEqual(expected);
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
    expect(balances[0]).toMatchObject({ symbol: "USDC", amount: 0, value: 0 });
  });

  it("total value equals account equity (positions do not double-count)", () => {
    const total = parseClearinghouseState(fixture).reduce((s, b) => s + b.value, 0);
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

  // 地址格式校验已上移到 sync/create 的 validateCredentials(见 @folio/balances-basic inputs.test);
  // hyperliquid 无全局 key,provider 本身不再预检 creds → 此处不测"无请求即拒"。

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
    expect(providers).toContain(hyperliquidProvider);
  });
});
