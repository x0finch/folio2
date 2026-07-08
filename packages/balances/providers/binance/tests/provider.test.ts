import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binanceProvider, entries, parseAccountBalances } from "../src";
import account from "./fixtures/account.json";
import expected from "./fixtures/expected-balances.json";
import prices from "./fixtures/prices.json";

function ctx(creds: FetchContext["creds"] = { apiKey: "k", secret: "s" }): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "exchange_binance", label: "Binance" },
    creds,
  };
}

afterEach(() => vi.restoreAllMocks());

// 两份 fixture 一一对应:account.json(录制的 /api/v3/account 响应)+ prices.json(行情价映射)
// → expected-balances.json(解析后的期望值)。覆盖:free+locked 合并、按价估值(稳定币≈1、
// 无交易对→0)、跳过零余额(BNB)。JSON 无 undefined → expected 省略未定义字段(toEqual 视缺键==undefined)。
describe("parseAccountBalances (golden: fixtures in → fixture out)", () => {
  const balances = parseAccountBalances(account, prices);

  it("maps the recorded account + price map to expected-balances", () => {
    expect(balances).toEqual(expected);
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

  it("entry registers accountType exchange_binance", () => {
    expect(entries.map((e) => e.manifest.accountType)).toContain("exchange_binance");
  });
});

describe("binanceProvider.validate", () => {
  it("false on missing creds without a request; true on 200; false on 401", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await binanceProvider.validateAccount(ctx({ apiKey: "k" }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await binanceProvider.validateAccount(ctx())).toBe(true);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await binanceProvider.validateAccount(ctx())).toBe(false);
  });
});
