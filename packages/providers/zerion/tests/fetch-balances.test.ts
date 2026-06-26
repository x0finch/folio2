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

describe("parsePositions (golden)", () => {
  const balances = parsePositions(fixture);

  it("maps displayable positions, skips hidden/trash", () => {
    // fixture 有 5 条,其中 1 条 displayable=false → 应被过滤,余 4 条。
    expect(balances).toHaveLength(4);
    expect(balances.find((b) => b.symbol === "SPAM")).toBeUndefined();
  });

  it("classifies wallet→spot and staked/protocol→defi", () => {
    expect(balances.find((b) => b.symbol === "ETH")?.kind).toBe("spot");
    expect(balances.find((b) => b.symbol === "USDC")?.kind).toBe("spot");
    const steth = balances.find((b) => b.symbol === "stETH");
    expect(steth?.kind).toBe("defi");
    expect(steth?.meta?.protocol).toBe("Lido");
  });

  it("carries chain into source + meta, amount/usdValue from quantity.float/value", () => {
    const usdc = balances.find((b) => b.symbol === "USDC");
    expect(usdc).toMatchObject({ amount: 1500, usdValue: 1500, source: "arbitrum" });
    expect(usdc?.meta?.chain).toBe("arbitrum");
    expect(balances.find((b) => b.symbol === "ETH")?.meta?.chain).toBe("ethereum");
  });

  it("treats null value as 0", () => {
    expect(balances.find((b) => b.symbol === "UNP")?.usdValue).toBe(0);
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

  it("maps 429 → RATE_LIMITED (retryable) and 401 → AUTH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    await expect(zerionProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
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
