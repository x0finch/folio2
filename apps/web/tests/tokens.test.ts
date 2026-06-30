import type { CoinId, TokenInfo, TokenPrice, TokenRef } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import { balanceToAssetRef, toEnrichment } from "../src/lib/tokens";

const meta = (o: Record<string, unknown>) => JSON.stringify(o);
const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });

describe("balanceToAssetRef", () => {
  it("spot with chain + contractAddress (coinstats) → full AssetRef", () => {
    expect(
      balanceToAssetRef({
        symbol: "USDC",
        kind: "spot",
        metaJson: meta({ chain: "solana", contractAddress: "Mint111" }),
      }),
    ).toEqual({ symbol: "USDC", chain: "solana", contract: "Mint111" });
  });

  it("spot with chain only (zerion, no contract) → symbol + chain", () => {
    expect(
      balanceToAssetRef({ symbol: "ETH", kind: "spot", metaJson: meta({ chain: "ethereum" }) }),
    ).toEqual({ symbol: "ETH", chain: "ethereum", contract: undefined });
  });

  it("manual (no meta) → symbol only", () => {
    expect(balanceToAssetRef({ symbol: "BTC", kind: "manual", metaJson: null })).toEqual({
      symbol: "BTC",
      chain: undefined,
      contract: undefined,
    });
  });

  it("defi / perp → null (not resolved)", () => {
    expect(
      balanceToAssetRef({ symbol: "X", kind: "defi", metaJson: meta({ protocol: "aave" }) }),
    ).toBeNull();
    expect(
      balanceToAssetRef({ symbol: "BTC", kind: "perp", metaJson: meta({ role: "equity" }) }),
    ).toBeNull();
  });

  it("corrupt metaJson → falls back to symbol-only (no throw)", () => {
    expect(balanceToAssetRef({ symbol: "ETH", kind: "spot", metaJson: "<<bad>>" })).toEqual({
      symbol: "ETH",
      chain: undefined,
      contract: undefined,
    });
  });
});

describe("toEnrichment", () => {
  const info: TokenInfo = { ref: cg("bitcoin"), symbol: "btc", name: "Bitcoin", logo: "L" };
  const price: TokenPrice = { ref: cg("bitcoin"), unitPrice: 65000, change24h: 1.5, asOf: 0 };

  it("merges info + price", () => {
    expect(toEnrichment(info, price)).toEqual({
      name: "Bitcoin",
      logo: "L",
      unitPrice: 65000,
      change24h: 1.5,
    });
  });

  it("missing → all undefined (graceful degrade)", () => {
    expect(toEnrichment(undefined, undefined)).toEqual({
      name: undefined,
      logo: undefined,
      unitPrice: undefined,
      change24h: undefined,
    });
  });
});
