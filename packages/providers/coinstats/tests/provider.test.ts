import type { FetchContext } from "@folio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCoinstats, providers } from "../src";
import fixture from "./fixtures/balances.json";

const SUI = "0xc0ffee254729296a45a3885639AC7E10F9d54979c0ffee254729296a45a38856";

function ctx(creds: FetchContext["creds"], globalKeys: Record<string, string>): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_sui", label: "Wallet" },
    creds,
    globalKeys,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("coinstats factory (方案 A multi-type)", () => {
  it("emits one provider per configured type, all declaring usesGlobalKeys", () => {
    const types = providers.map((p) => p.accountType).sort();
    expect(types).toEqual(["onchain_cosmos", "onchain_solana", "onchain_sui"]);
    for (const p of providers) expect(p.usesGlobalKeys).toEqual(["COINSTATS_API_KEY"]);
  });

  it("binds the right connectionId per type", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));
    const sui = makeCoinstats("onchain_sui", "sui-wallet");
    await sui.fetchBalances(ctx({ identifier: SUI }, { COINSTATS_API_KEY: "k" }));
    expect(String(spy.mock.calls[0][0])).toContain("connectionId=sui-wallet");
  });
});

describe("coinstats fetchBalances", () => {
  const provider = makeCoinstats("onchain_solana", "solana");

  it("sends X-API-KEY and parses balances", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    const balances = await provider.fetchBalances(
      ctx({ identifier: "addr" }, { COINSTATS_API_KEY: "k" }),
    );
    expect(balances).toHaveLength(6);
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>)["X-API-KEY"]).toBe("k");
  });

  it("throws INVALID_CREDENTIALS on missing address or key (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(provider.fetchBalances(ctx({}, { COINSTATS_API_KEY: "k" }))).rejects.toMatchObject(
      {
        code: "INVALID_CREDENTIALS",
      },
    );
    await expect(provider.fetchBalances(ctx({ identifier: "addr" }, {}))).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps 429 → RATE_LIMITED and 401 → AUTH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    await expect(
      provider.fetchBalances(ctx({ identifier: "addr" }, { COINSTATS_API_KEY: "k" })),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(
      provider.fetchBalances(ctx({ identifier: "addr" }, { COINSTATS_API_KEY: "k" })),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});

describe("coinstats validate", () => {
  const provider = makeCoinstats("onchain_solana", "solana");

  it("false on missing address/key without a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await provider.validate(ctx({}, { COINSTATS_API_KEY: "k" }))).toBe(false);
    expect(await provider.validate(ctx({ identifier: "addr" }, {}))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("true on 200, false on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    expect(await provider.validate(ctx({ identifier: "addr" }, { COINSTATS_API_KEY: "k" }))).toBe(
      true,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await provider.validate(ctx({ identifier: "addr" }, { COINSTATS_API_KEY: "k" }))).toBe(
      false,
    );
  });
});
