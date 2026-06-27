import type { FetchContext } from "@folio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePositions, providers, zerionProvider } from "../src";
import fixture from "./fixtures/positions.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function ctx(overrides: Partial<FetchContext> = {}): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_evm", label: "Wallet" },
    creds: { identifier: ADDR },
    globalKeys: { ZERION_API_KEY: "test-key" },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// fixture = 录制的真实 positions 响应(解析器输入)。整份解析结果一次性钉成 golden(toEqual),
// 覆盖:amount=quantity.float、usdValue=value(null→0)、wallet→spot 与 staked/protocol→defi、
// 每条仓位的 chain 入 source+meta、protocol/positionType 入 meta、跳过 displayable=false。
describe("parsePositions (golden)", () => {
  const balances = parsePositions(fixture);

  it("maps the recorded response to the expected Balance[]", () => {
    expect(balances).toEqual([
      {
        symbol: "ETH",
        amount: 2.5,
        usdValue: 6250,
        source: "ethereum",
        kind: "spot",
        meta: { chain: "ethereum", protocol: undefined, positionType: "wallet" },
      },
      {
        symbol: "USDC",
        amount: 1500,
        usdValue: 1500,
        source: "arbitrum",
        kind: "spot",
        meta: { chain: "arbitrum", protocol: undefined, positionType: "wallet" },
      },
      {
        symbol: "stETH",
        amount: 4,
        usdValue: 10000,
        source: "ethereum",
        kind: "defi",
        meta: { chain: "ethereum", protocol: "Lido", positionType: "staked" },
      },
      {
        symbol: "UNP",
        amount: 100,
        usdValue: 0,
        source: "ethereum",
        kind: "spot",
        meta: { chain: "ethereum", protocol: undefined, positionType: "wallet" },
      },
    ]);
  });

  it("excludes hidden/trash (displayable=false) positions", () => {
    // fixture 有 5 条,其中 1 条 displayable=false → 解析结果 4 条,无该条。
    expect(balances).toHaveLength(4);
    expect(balances.find((b) => b.symbol === "SPAM")).toBeUndefined();
  });
});

describe("zerionProvider.fetchBalances", () => {
  it("fetches positions with Basic auth and parses them", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    const balances = await zerionProvider.fetchBalances(ctx());
    expect(balances).toHaveLength(4);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain(`/v1/wallets/${ADDR}/positions/`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("test-key:")}`,
    );
  });

  it("throws INVALID_CREDENTIALS on missing/invalid address or key (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(zerionProvider.fetchBalances(ctx({ creds: {} }))).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    await expect(zerionProvider.fetchBalances(ctx({ globalKeys: {} }))).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps 429 → RATE_LIMITED (retryable, parses Retry-After) and 401 → AUTH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
    );
    await expect(zerionProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 3000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(zerionProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("serves accountType onchain_evm and is exported in providers", () => {
    expect(zerionProvider.accountType).toBe("onchain_evm");
    expect(providers).toContain(zerionProvider);
  });
});
