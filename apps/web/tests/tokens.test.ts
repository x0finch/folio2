import { cgkRef } from "@folio/oracle";
import { describe, expect, it } from "vitest";
import { balanceToAssetRef, toEnrichment } from "../src/lib/tokens";

const cg = cgkRef;

describe("balanceToAssetRef", () => {
  it("spot with tokenRef → carries it as the resolution impl key", () => {
    expect(
      balanceToAssetRef({
        symbol: "USDC",
        kind: "spot",
        tokenRef: "eip155:42161/erc20:0xaf88",
      }),
    ).toEqual({ symbol: "USDC", tokenRef: "eip155:42161/erc20:0xaf88" });
  });

  it("spot without tokenRef (native/CEX) → symbol only", () => {
    expect(balanceToAssetRef({ symbol: "ETH", kind: "spot", tokenRef: null })).toEqual({
      symbol: "ETH",
      tokenRef: undefined,
    });
  });

  it("manual (no identifier) → symbol only", () => {
    expect(balanceToAssetRef({ symbol: "BTC", kind: "manual" })).toEqual({
      symbol: "BTC",
      tokenRef: undefined,
    });
  });

  it("defi / perp → null (not resolved)", () => {
    expect(balanceToAssetRef({ symbol: "X", kind: "defi" })).toBeNull();
    expect(balanceToAssetRef({ symbol: "BTC", kind: "perp" })).toBeNull();
  });
});

describe("toEnrichment(logo → 内部 id 代理,source 无关)", () => {
  it("有内部 id + CGK logo → 代理 URL(不直引 CoinGecko)", () => {
    expect(
      toEnrichment({
        ref: cg("bitcoin"),
        id: "tok-btc",
        name: "Bitcoin",
        logo: "cgk-L",
        providerLogo: "prov-L",
        unitPrice: 65000,
        change24h: 1.5,
      }),
    ).toEqual({
      name: "Bitcoin",
      logo: "/api/logo/token/tok-btc",
      unitPrice: 65000,
      change24h: 1.5,
    });
  });

  it("孤儿(ref=null)有内部 id + 仅 providerLogo → 也代理(不直引 provider CDN)", () => {
    expect(
      toEnrichment({ ref: null, id: "tok-orphan", name: "Foo", providerLogo: "prov-L" }),
    ).toEqual({
      name: "Foo",
      logo: "/api/logo/token/tok-orphan",
      unitPrice: undefined,
      change24h: undefined,
    });
  });

  it("无内部 id(不在 store)+ providerLogo → 原样兜底(降级)", () => {
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
