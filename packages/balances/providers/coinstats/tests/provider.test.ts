import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCoinstats, providers } from "../src";
import fixture from "./fixtures/balances.json";

const SUI = "0xc0ffee254729296a45a3885639AC7E10F9d54979c0ffee254729296a45a38856";

function ctx(creds: FetchContext["creds"]): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_sui", label: "Wallet" },
    creds,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("coinstats factory (方案 A multi-type)", () => {
  it("emits one provider per configured type", () => {
    const types = providers.map((p) => p.accountType).sort();
    expect(types).toEqual(["onchain_cosmos", "onchain_solana", "onchain_sui"]);
  });

  it("binds the right connectionId per type", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));
    const sui = makeCoinstats("onchain_sui", "sui-wallet", "k");
    await sui.fetchBalances(ctx({ identifier: SUI }));
    expect(String(spy.mock.calls[0][0])).toContain("connectionId=sui-wallet");
  });
});

describe("coinstats fetchBalances", () => {
  const provider = makeCoinstats("onchain_solana", "solana", "k");

  it("sends X-API-KEY and parses balances", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    const balances = await provider.fetchBalances(ctx({ identifier: "addr" }));
    expect(balances).toHaveLength(6);
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>)["X-API-KEY"]).toBe("k");
  });

  // 地址由 validateCredentials 预校验;provider 只对全局 key 缺失自查(不发请求)。
  it("throws INVALID_CREDENTIALS when the global key is missing (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const keyless = makeCoinstats("onchain_solana", "solana");
    await expect(keyless.fetchBalances(ctx({ identifier: "addr" }))).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps 429 → RATE_LIMITED and 401 → AUTH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    await expect(provider.fetchBalances(ctx({ identifier: "addr" }))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(provider.fetchBalances(ctx({ identifier: "addr" }))).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });
});

describe("coinstats validate", () => {
  const provider = makeCoinstats("onchain_solana", "solana", "k");

  it("false when the global key is missing, without a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const keyless = makeCoinstats("onchain_solana", "solana");
    expect(await keyless.validateAccount(ctx({ identifier: "addr" }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("true on 200, false on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    expect(await provider.validateAccount(ctx({ identifier: "addr" }))).toBe(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await provider.validateAccount(ctx({ identifier: "addr" }))).toBe(false);
  });
});
