import type { CgkCoinId, TokenRef } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import { balanceToAssetRef, toEnrichment } from "../src/lib/tokens";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });

describe("balanceToAssetRef", () => {
  it("spot with tokenIdentifier → carries it as the resolution impl key", () => {
    expect(
      balanceToAssetRef({
        symbol: "USDC",
        kind: "spot",
        tokenIdentifier: "eip155:42161/erc20:0xaf88",
      }),
    ).toEqual({ symbol: "USDC", tokenIdentifier: "eip155:42161/erc20:0xaf88" });
  });

  it("spot without tokenIdentifier (native/CEX) → symbol only", () => {
    expect(balanceToAssetRef({ symbol: "ETH", kind: "spot", tokenIdentifier: null })).toEqual({
      symbol: "ETH",
      tokenIdentifier: undefined,
    });
  });

  it("manual (no identifier) → symbol only", () => {
    expect(balanceToAssetRef({ symbol: "BTC", kind: "manual" })).toEqual({
      symbol: "BTC",
      tokenIdentifier: undefined,
    });
  });

  it("defi / perp → null (not resolved)", () => {
    expect(balanceToAssetRef({ symbol: "X", kind: "defi" })).toBeNull();
    expect(balanceToAssetRef({ symbol: "BTC", kind: "perp" })).toBeNull();
  });
});

describe("toEnrichment(logo 回退链:CGK → provider 备用)", () => {
  it("flattens a full enriched asset (CGK logo wins)", () => {
    expect(
      toEnrichment({
        ref: cg("bitcoin"),
        name: "Bitcoin",
        logo: "cgk-L",
        providerLogo: "prov-L",
        unitPrice: 65000,
        change24h: 1.5,
      }),
    ).toEqual({ name: "Bitcoin", logo: "cgk-L", unitPrice: 65000, change24h: 1.5 });
  });

  it("CGK logo missing → falls back to provider logo(孤儿也有图可显)", () => {
    expect(toEnrichment({ ref: null, name: "Foo", providerLogo: "prov-L" })).toEqual({
      name: "Foo",
      logo: "prov-L",
      unitPrice: undefined,
      change24h: undefined,
    });
  });

  it("empty → all undefined (graceful degrade)", () => {
    expect(toEnrichment({ ref: null })).toEqual({
      name: undefined,
      logo: undefined,
      unitPrice: undefined,
      change24h: undefined,
    });
  });
});
