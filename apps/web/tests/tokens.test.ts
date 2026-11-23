import type { TokenRecord } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { ZERO_DISPLAY_USD } from "@/lib/core/account-view";
import {
  defiTokenId,
  displayTokenId,
  displayTokenIds,
  fungibleTokenId,
  perpTokenId,
  refreshableTokenIds,
  toEnrichment,
} from "@/lib/core/token-model";

const rec = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  id: "tk-btc",
  ref: "coingecko/issued:bitcoin",
  symbol: "BTC",
  name: "Bitcoin",
  infoStale: false,
  ...over,
});

describe("fungibleTokenId (gate for deriving valuation)", () => {
  it("spot with token_id: returned", () => {
    expect(fungibleTokenId({ kind: "spot", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("kind is normalized via viewKind: legacy manual / bitcoin count as fungible", () => {
    expect(fungibleTokenId({ kind: "manual", tokenId: "tk-1" })).toBe("tk-1");
    expect(fungibleTokenId({ kind: "bitcoin", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("no token_id (old snapshot / row synthesized from manual): null, excluded", () => {
    expect(fungibleTokenId({ kind: "spot" })).toBeNull();
    expect(fungibleTokenId({ kind: "spot", tokenId: null })).toBeNull();
  });

  it("defi / perp do not pass this gate (their value comes from typed meta)", () => {
    expect(fungibleTokenId({ kind: "defi", tokenId: "tk-1" })).toBeNull();
    expect(fungibleTokenId({ kind: "perp", tokenId: "tk-1" })).toBeNull();
  });
});

describe("defiTokenId (feeds display enrichment only, not valuation)", () => {
  it("defi row with token_id: returned (needed for the protocol row 24h aggregate)", () => {
    expect(defiTokenId({ kind: "defi", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("non-defi: null", () => {
    expect(defiTokenId({ kind: "spot", tokenId: "tk-1" })).toBeNull();
  });
});

describe("perpTokenId (feeds display enrichment only, not valuation)", () => {
  it("perp position row with token_id: returned (account row badge needs the underlying token image)", () => {
    expect(perpTokenId({ kind: "perp_position", tokenId: "tk-1" })).toBe("tk-1");
  });

  it('**equity rows excluded**: it is collateral, not "what is held"', () => {
    expect(perpTokenId({ kind: "perp_equity", tokenId: "tk-1" })).toBeNull();
  });

  it("non-perp: null", () => {
    expect(perpTokenId({ kind: "spot", tokenId: "tk-1" })).toBeNull();
  });
});

describe("displayTokenId / displayTokenIds (unified gate for display enrichment)", () => {
  it("fungible, defi and perp positions are all inside the display gate", () => {
    expect(displayTokenId({ kind: "spot", tokenId: "tk-1" })).toBe("tk-1");
    expect(displayTokenId({ kind: "defi", tokenId: "tk-2" })).toBe("tk-2");
    expect(displayTokenId({ kind: "perp_position", tokenId: "tk-3" })).toBe("tk-3");
  });

  it("perp **equity** rows stay outside the gate (collateral: no badge, nobody needs its image)", () => {
    expect(displayTokenId({ kind: "perp_equity", tokenId: "tk-4" })).toBeNull();
  });

  it("batch id extraction dedupes and drops rows without identity", () => {
    expect(
      displayTokenIds([
        { kind: "spot", tokenId: "tk-1" },
        { kind: "spot", tokenId: "tk-1" },
        { kind: "spot" },
        { kind: "defi", tokenId: "tk-2" },
      ]),
    ).toEqual(["tk-1", "tk-2"]);
  });
});

describe("refreshableTokenIds (skips dust before refresh)", () => {
  it("value ≥ threshold: kept; dust (almost $0): dropped", () => {
    expect(
      refreshableTokenIds([
        { kind: "spot", tokenId: "tk-real", usdValue: 1200 },
        { kind: "spot", tokenId: "tk-dust", usdValue: 0.0001 },
        { kind: "spot", tokenId: "tk-zero", usdValue: 0 },
      ]),
    ).toEqual(["tk-real"]);
  });

  it("same token across holdings: judged by aggregate value (each dust but together enough: kept)", () => {
    const half = ZERO_DISPLAY_USD * 0.6;
    expect(
      refreshableTokenIds([
        { kind: "spot", tokenId: "tk-1", usdValue: half },
        { kind: "spot", tokenId: "tk-1", usdValue: half },
      ]),
    ).toEqual(["tk-1"]);
  });

  it("defi rows count too (inside the display gate), filtered by value", () => {
    expect(
      refreshableTokenIds([
        { kind: "defi", tokenId: "tk-defi", usdValue: 500 },
        { kind: "defi", tokenId: "tk-defi-dust", usdValue: 0.001 },
      ]),
    ).toEqual(["tk-defi"]);
  });

  it("spot + defi borrow leg hedge (net ≈ 0): still kept (sum of absolutes, not absolute of sum)", () => {
    expect(
      refreshableTokenIds([
        { kind: "spot", tokenId: "tk-usdc", usdValue: 500 },
        { kind: "defi", tokenId: "tk-usdc", usdValue: -500 },
      ]),
    ).toEqual(["tk-usdc"]);
  });

  it("rows without identity are excluded (same gate as displayTokenIds)", () => {
    expect(refreshableTokenIds([{ kind: "spot", usdValue: 999 }])).toEqual([]);
  });

  it("perp positions enter the price refresh set with the display gate (equity rows do not)", () => {
    expect(
      refreshableTokenIds([
        { kind: "perp_position", tokenId: "tk-perp", usdValue: 999 },
        { kind: "perp_equity", tokenId: "tk-equity", usdValue: 5000 },
      ]),
    ).toEqual(["tk-perp"]);
  });

  it("perp positions: always kept, even with usdValue 0 (structurally 0)", () => {
    expect(
      refreshableTokenIds([{ kind: "perp_position", tokenId: "tk-perp", usdValue: 0 }]),
    ).toEqual(["tk-perp"]);
  });

  it("usdValue missing: always kept (cannot judge, so no false drop)", () => {
    expect(refreshableTokenIds([{ kind: "spot", tokenId: "tk-unknown" }])).toEqual(["tk-unknown"]);
  });

  it("manual holdings: always kept, even if the computed value is 0", () => {
    expect(
      refreshableTokenIds([
        { kind: "spot", tokenId: "tk-manual", usdValue: 0, platform: "manual" },
      ]),
    ).toEqual(["tk-manual"]);
  });

  it("threshold is injectable (default = display threshold ZERO_DISPLAY_USD)", () => {
    const rows = [{ kind: "spot" as const, tokenId: "tk-1", usdValue: 5 }];
    expect(refreshableTokenIds(rows, 10)).toEqual([]);
    expect(refreshableTokenIds(rows)).toEqual(["tk-1"]);
  });
});

describe("toEnrichment (logos always go through the proxy, never straight to a third-party CDN)", () => {
  it("upstream image: proxy URL", () => {
    expect(
      toEnrichment(
        rec({
          logo: "upstream-L",
          providerLogo: "prov-L",
          price: { unitPrice: 65000, change24h: 1.5, marketCapRank: 1, asOf: 0, stale: false },
        }),
      ),
    ).toEqual({
      symbol: "BTC",
      name: "Bitcoin",
      logo: "/api/logo/token/tk-btc",
      unitPrice: 65000,
      marketCapRank: 1,
    });
  });

  it("token not yet recognized upstream (ref null) with only a connector-provided image: still proxied", () => {
    expect(toEnrichment(rec({ ref: null, id: "tk-orphan", providerLogo: "prov-L" }))).toEqual({
      symbol: "BTC",
      name: "Bitcoin",
      logo: "/api/logo/token/tk-orphan",
      unitPrice: undefined,
      marketCapRank: undefined,
    });
  });

  it("no image at all: no logo (client shows the initial, sends no request)", () => {
    expect(toEnrichment(rec())).toEqual({
      symbol: "BTC",
      name: "Bitcoin",
      logo: undefined,
      unitPrice: undefined,
      marketCapRank: undefined,
    });
  });
});
