import { describe, expect, it } from "vitest";
import { connectorLabelFallback } from "@/lib/core/logo";

// Label shown before the connector catalog arrives, so raw ids like `hyperliquid` never flash on screen.
// Expected values must match each manifest's `label` (the source of truth).
describe("connectorLabelFallback", () => {
  it("capitalizes the first letter", () => {
    expect(connectorLabelFallback("hyperliquid")).toBe("Hyperliquid");
    expect(connectorLabelFallback("bitcoin")).toBe("Bitcoin");
    expect(connectorLabelFallback("binance")).toBe("Binance");
    expect(connectorLabelFallback("bybit")).toBe("Bybit");
    expect(connectorLabelFallback("manual")).toBe("Manual");
    expect(connectorLabelFallback("solana")).toBe("Solana");
    expect(connectorLabelFallback("cosmos")).toBe("Cosmos");
  });

  it("acronyms aren't just capitalized — these two are hard-coded per the manifest", () => {
    expect(connectorLabelFallback("evm")).toBe("EVM");
    expect(connectorLabelFallback("okx")).toBe("OKX");
  });

  it("not every three-letter id is an acronym — so 'short means all caps' is wrong", () => {
    // `sui`'s manifest name is "Sui".
    expect(connectorLabelFallback("sui")).toBe("Sui");
  });

  it("unknown ids don't leak a lowercase internal name either", () => {
    expect(connectorLabelFallback("newvenue")).toBe("Newvenue");
  });

  it("empty string returned as-is (no throw)", () => {
    expect(connectorLabelFallback("")).toBe("");
  });
});
