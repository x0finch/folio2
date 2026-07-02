import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hyperliquidProvider } from "../src";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function ctx(creds: FetchContext["creds"]): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "perp_hyperliquid", label: "HL" },
    creds,
    globalKeys: {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hyperliquidProvider.validate", () => {
  it("returns true when the address probes the info endpoint with 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await hyperliquidProvider.validate(ctx({ identifier: ADDR }))).toBe(true);
  });

  // 地址格式校验已上移到 validateCredentials;hyperliquid.validate 直接探活(不再预检地址)。
  it("returns false on non-ok response or network error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    expect(await hyperliquidProvider.validate(ctx({ identifier: ADDR }))).toBe(false);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await hyperliquidProvider.validate(ctx({ identifier: ADDR }))).toBe(false);
  });
});
