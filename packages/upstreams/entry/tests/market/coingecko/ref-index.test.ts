import { tokenRef } from "@folio/oracle-ref";
import { describe, expect, it } from "vitest";
import type { AssetPlatform, CoinListItem } from "../../../src/market/coingecko/api";
import { ID as UPSTREAM_ID } from "../../../src/market/coingecko/constants";
import { toRefIndexRows } from "../../../src/market/coingecko/ref-index";
import assetPlatforms from "./fixtures/asset-platforms.json" with { type: "json" };
import coinsList from "./fixtures/coins-list.json" with { type: "json" };

const COINS = coinsList as CoinListItem[];
const PLATFORMS = assetPlatforms as AssetPlatform[];

// Both sides are full tokenRefs; the right side is never a bare coin id.
const cgk = (id: string) => tokenRef.issued(UPSTREAM_ID, id);

describe("toRefIndexRows: pure conversion (golden)", () => {
  const result = toRefIndexRows(COINS, PLATFORMS);
  const byChain = new Map(result.rows.map((r) => [r.chainRef, r.upstreamRef]));

  it("chainRef is always `contract:` shaped: every row here is an on-chain contract", () => {
    expect(result.rows.every((r) => r.chainRef.includes("/contract:"))).toBe(true);
  });

  it("upstreamRef is always this adapter's full `issued:` name (never a bare id)", () => {
    expect(result.rows.every((r) => r.upstreamRef.startsWith(`${UPSTREAM_ID}/issued:`))).toBe(true);
  });

  it("EVM platforms map to evm:<chainId> with lowercase addresses; right side is the full upstream ref", () => {
    expect(byChain.get("evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(
      cgk("usd-coin"),
    );
    expect(byChain.get("evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831")).toBe(
      cgk("usd-coin"),
    );
    expect(byChain.get("evm:8453/contract:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toBe(
      cgk("usd-coin"),
    );
  });

  it("non-EVM uses the explicit table and keeps addresses verbatim (base58 / bech32 are case-sensitive)", () => {
    expect(byChain.get("solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      cgk("usd-coin"),
    );
    expect(byChain.get("cosmos/contract:uatom")).toBe(cgk("cosmos"));
    expect(byChain.get("sui/contract:0xSuiTokenAddress00000000000000000000000000AB")).toBe(
      cgk("suicoin"),
    );
  });

  it("native coins yield no row (empty platforms dict; matched by symbol)", () => {
    expect(result.rows.some((r) => r.upstreamRef === cgk("bitcoin"))).toBe(false);
    expect(result.rows.some((r) => r.upstreamRef === cgk("ethereum"))).toBe(false);
  });

  it("untracked chains are only counted: no row, no warning (CoinGecko has ~200)", () => {
    expect(result.rows.some((r) => r.chainRef.startsWith("tron/"))).toBe(false);
    expect(result.skipped).toBe(1); // usd-coin's tron entry
    expect(result.unmatchedPlatforms).toEqual([]);
  });

  it("malformed entries are skipped: no id, null / blank address, missing platforms key", () => {
    expect(byChain.has("evm:1/contract:0xbeef")).toBe(false);
    expect(result.rows.some((r) => r.upstreamRef === cgk("null-address"))).toBe(false);
    expect(result.rows.some((r) => r.upstreamRef === cgk("no-platforms-key"))).toBe(false);
  });

  it("pins whole row count and keys (golden; key = chainRef)", () => {
    expect([...byChain.keys()].sort()).toEqual([
      "cosmos/contract:uatom",
      "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "evm:8453/contract:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "sui/contract:0xSuiTokenAddress00000000000000000000000000AB",
    ]);
  });
});

describe("chain table mismatch", () => {
  it("a requested non-EVM chain missing from the platform table is reported, not silent", () => {
    // Case: CoinGecko renamed the sui platform to sui-network in both the platform table and the catalogue.
    const renamed = PLATFORMS.map((p) => (p.id === "sui" ? { ...p, id: "sui-network" } : p));
    const coins = COINS.map((c) =>
      c.platforms?.sui ? { ...c, platforms: { "sui-network": c.platforms.sui } } : c,
    );
    const result = toRefIndexRows(coins, renamed);

    expect(result.unmatchedPlatforms).toEqual(["sui"]);
    // That chain really has no rows now; unreported, it would silently lose prices and logos.
    expect(result.rows.some((r) => r.chainRef.startsWith("sui"))).toBe(false);
  });
});
