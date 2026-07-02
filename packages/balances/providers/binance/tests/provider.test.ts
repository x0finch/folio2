import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binanceProvider, parseAccountBalances, providers } from "../src";
import account from "./fixtures/account.json";

const prices = { BTCUSDT: 60000, ETHUSDT: 3000, BNBUSDT: 500 };

function ctx(creds: FetchContext["creds"] = { apiKey: "k", secret: "s" }): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "exchange_binance", label: "Binance" },
    creds,
    globalKeys: {},
  };
}

afterEach(() => vi.restoreAllMocks());

describe("parseAccountBalances (golden)", () => {
  const balances = parseAccountBalances(account, prices);

  it("maps free+locked, values via price (stablecoin≈1, no-pair→0), skips zero", () => {
    expect(balances).toEqual([
      {
        symbol: "BTC",
        amount: 0.5,
        usdValue: 30000,
        source: "binance",
        kind: "spot",
        meta: { wallet: "spot" },
      },
      {
        symbol: "ETH",
        amount: 3, // 2 free + 1 locked
        usdValue: 9000,
        source: "binance",
        kind: "spot",
        meta: { wallet: "spot" },
      },
      {
        symbol: "USDT",
        amount: 1000,
        usdValue: 1000, // stablecoin ≈ 1
        source: "binance",
        kind: "spot",
        meta: { wallet: "spot" },
      },
      {
        symbol: "NOPRICE",
        amount: 5,
        usdValue: 0, // no NOPRICEUSDT pair
        source: "binance",
        kind: "spot",
        meta: { wallet: "spot" },
      },
    ]);
    // BNB has zero balance → excluded
    expect(balances.find((b) => b.symbol === "BNB")).toBeUndefined();
  });
});

describe("binanceProvider.fetchBalances", () => {
  it("signs /api/v3/account (X-MBX-APIKEY + signature) + fetches public prices, then parses", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/api/v3/account"))
        return new Response(JSON.stringify(account), { status: 200 });
      return new Response(
        JSON.stringify([
          { symbol: "BTCUSDT", price: "60000" },
          { symbol: "ETHUSDT", price: "3000" },
        ]),
        { status: 200 },
      );
    });

    const balances = await binanceProvider.fetchBalances(ctx());
    expect(balances.map((b) => b.symbol)).toEqual(["BTC", "ETH", "USDT", "NOPRICE"]);

    const [acctUrl, init] = spy.mock.calls[0];
    expect(String(acctUrl)).toContain("/api/v3/account?");
    expect(String(acctUrl)).toContain("&signature=");
    expect((init?.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe("k");
  });

  // 缺 key/secret 的拒绝已上移到 sync/create 的 validateCredentials(见 @folio/balances-basic inputs.test);
  // provider 信任已校验的 creds,故此处不再测"无请求即拒"。

  it("maps 429 → RATE_LIMITED with Retry-After, 401 → AUTH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
    );
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 2000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("serves exchange_binance, no usesGlobalKeys, exported in providers", () => {
    expect(binanceProvider.accountType).toBe("exchange_binance");
    expect(binanceProvider.usesGlobalKeys).toBeUndefined(); // 每账户密钥,不用全局 key
    expect(providers).toContain(binanceProvider);
  });
});

describe("binanceProvider.validate", () => {
  it("false on missing creds without a request; true on 200; false on 401", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await binanceProvider.validate(ctx({ apiKey: "k" }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await binanceProvider.validate(ctx())).toBe(true);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await binanceProvider.validate(ctx())).toBe(false);
  });
});
