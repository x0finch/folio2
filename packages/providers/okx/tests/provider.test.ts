import type { FetchContext } from "@folio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { okxProvider, parseBalances, providers } from "../src";
import balance from "./fixtures/balance.json";

const CREDS = { apiKey: "k", secret: "s", passphrase: "p" };
function ctx(creds: FetchContext["creds"] = CREDS): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "exchange_okx", label: "OKX" },
    creds,
    globalKeys: {},
  };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.restoreAllMocks());

describe("parseBalances (golden)", () => {
  it("maps eq→amount, eqUsd→usdValue (OKX-provided), skips zero/empty", () => {
    expect(parseBalances(balance.data[0].details)).toEqual([
      {
        symbol: "BTC",
        amount: 0.5,
        usdValue: 30000,
        source: "okx",
        kind: "spot",
        meta: { wallet: "trading" },
      },
      {
        symbol: "USDT",
        amount: 1000,
        usdValue: 1000,
        source: "okx",
        kind: "spot",
        meta: { wallet: "trading" },
      },
      {
        symbol: "ETH",
        amount: 2,
        usdValue: 6000,
        source: "okx",
        kind: "spot",
        meta: { wallet: "trading" },
      },
    ]); // DUST (eq 0) excluded
  });
});

describe("okxProvider.fetchBalances", () => {
  it("signs with 4 OK-ACCESS headers (base64 SIGN) and parses balances", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(balance));
    const balances = await okxProvider.fetchBalances(ctx());
    expect(balances.map((b) => b.symbol)).toEqual(["BTC", "USDT", "ETH"]);

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/api/v5/account/balance");
    const h = init?.headers as Record<string, string>;
    expect(h["OK-ACCESS-KEY"]).toBe("k");
    expect(h["OK-ACCESS-PASSPHRASE"]).toBe("p");
    expect(h["OK-ACCESS-TIMESTAMP"]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO8601
    expect(h["OK-ACCESS-SIGN"]).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
  });

  it("throws INVALID_CREDENTIALS when any of key/secret/passphrase missing (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(
      okxProvider.fetchBalances(ctx({ apiKey: "k", secret: "s" })),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps HTTP-200 + auth code → AUTH_FAILED (OKX error model)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ code: "50113", msg: "Invalid Sign" }));
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("maps HTTP-200 + non-auth code → UPSTREAM_ERROR; 429 → RATE_LIMITED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ code: "51000", msg: "param error" }));
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("serves exchange_okx, no usesGlobalKeys, exported in providers", () => {
    expect(okxProvider.accountType).toBe("exchange_okx");
    expect(okxProvider.usesGlobalKeys).toBeUndefined();
    expect(providers).toContain(okxProvider);
  });
});

describe("okxProvider.validate", () => {
  it("false on missing creds (no request); true on code 0; false on auth code", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await okxProvider.validate(ctx({ apiKey: "k", secret: "s" }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(balance));
    expect(await okxProvider.validate(ctx())).toBe(true);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ code: "50111", msg: "Invalid Key" }));
    expect(await okxProvider.validate(ctx())).toBe(false);
  });
});
