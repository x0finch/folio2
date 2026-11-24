import { describe, expect, it } from "vitest";
import { platformOf } from "../src/platform";

describe("platformOf", () => {
  it("on-chain holdings: the namer is the chain they live on", () => {
    expect(platformOf("evm:1/contract:0xa0b8", "evm")).toBe("evm:1");
    expect(platformOf("evm:42161/contract:0xaf88", "evm")).toBe("evm:42161"); // same account across chains: one cell each
    expect(platformOf("bitcoin/native", "bitcoin")).toBe("bitcoin");
    expect(platformOf("solana/contract:EPjFWdd5", "solana")).toBe("solana");
  });

  it("venues: the namer is the venue itself (coincides with connectorId)", () => {
    expect(platformOf("binance/issued:USDC", "binance")).toBe("binance");
    expect(platformOf("okx/issued:BTC", "okx")).toBe("okx");
    expect(platformOf("hyperliquid/issued:ETH", "hyperliquid")).toBe("hyperliquid");
  });

  it("manual without a chosen token: the namer is itself (manual), regular path", () => {
    expect(platformOf("manual/custom:FOO", "manual")).toBe("manual");
  });

  it("an unreadable string falls back to connectorId, never a half-built platform key", () => {
    expect(platformOf("nonsense", "binance")).toBe("binance");
    expect(platformOf("", "evm")).toBe("evm");
  });
});
