import type { FetchContext } from "@folio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zerionProvider } from "../src";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function ctx(creds: FetchContext["creds"], globalKeys: Record<string, string>): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_evm", label: "Wallet" },
    creds,
    globalKeys,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("zerionProvider.validate", () => {
  it("returns false on invalid address or missing key WITHOUT a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(
      await zerionProvider.validate(ctx({ identifier: "nope" }, { ZERION_API_KEY: "k" })),
    ).toBe(false);
    expect(await zerionProvider.validate(ctx({ identifier: ADDR }, {}))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("hits the lightweight portfolio endpoint and returns true on 200", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    expect(await zerionProvider.validate(ctx({ identifier: ADDR }, { ZERION_API_KEY: "k" }))).toBe(
      true,
    );
    expect(String(spy.mock.calls[0][0])).toContain(`/v1/wallets/${ADDR}/portfolio`);
  });

  it("returns false on 401/403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await zerionProvider.validate(ctx({ identifier: ADDR }, { ZERION_API_KEY: "k" }))).toBe(
      false,
    );
  });
});
