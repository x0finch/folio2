import type { UpstreamError } from "@folio/client-core";
import type { Effect } from "effect";
import type { PlatformMeta } from "./platform";
import type { TokenPrice, TokenPricePoint, TokenRef, TokenRefIndexRow } from "./types";

// Upstream ports (network), split by capability. The contract layer does not know who the upstream is: the implementation is injected as a
// Layer, so there is no apiKey, endpoint or DTO here; each upstream translates our chain identifiers into its own addressing. Prices are always USD.
// Errors reuse the four tagged errors of `@folio/client-core` (credentials / rate-limited / unreachable / unreadable): the consumer handles them
// the same way (degrade to the local old value), and catching by tag means "upstream down" is swallowed while our own bugs still blow up.
// `R` is `never`: the adapter's Layer provides the client and `HttpClient` itself, so no `Outbound` leaks into the service layer.
// Only `import type { Effect }`, as in stores.ts: this package is value-imported by the client.

// Id the adapter reports, same as `BalanceProvider.id` (lowercase slug); it is the namer of the tokenRefs it produces and the global map's `namer` column.
interface UpstreamIdentity {
  readonly id: string;
}

// The current upstream's naming identity: `id` plus its curated table. A separate port, not a face of `TokenUpstream`: mint needs these two
// and "no network on the write path" is a type fact, so depending on the whole `TokenUpstream` would wire the read path's network face in.
// `overrides`: symbol to this upstream's coin id (majors + known collisions), wins over market-cap rank; it holds one vendor's ids, so the adapter supplies it.
export interface Namer {
  readonly id: string;
  readonly overrides: Readonly<Record<string, string>>;
}

// Catalogue / discovery face: top-N warm + keyword search (both need the full catalogue).
export interface TokenMetaUpstream extends UpstreamIdentity {
  // One row with price + change + rank + name + logo; feeds the warm blob.
  fetchMarkets(opts: { topN: number }): Effect.Effect<UpstreamToken[], UpstreamError>;
  // Search by keyword (token picker disambiguation).
  searchTokens(query: string): Effect.Effect<UpstreamToken[], UpstreamError>;
}

// Point-lookup face: refresh prices / fetch history by known ref; needs no catalogue.
export interface PriceUpstream extends UpstreamIdentity {
  fetchPrices(refs: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenPrice>, UpstreamError>;
  // Whole rows (symbol / name / logo, maybe price) for known refs in a batch. Needed because upstream is the authority for these three fields:
  // rows are built from connector metadata, and an on-chain contract's symbol is a deployer string that can be stale (MATIC after the POL rename)
  // though the contract ref was recognised by address; overwriting with upstream's value removes the ambiguity. Unlisted refs are absent (not an error).
  fetchTokens(refs: readonly TokenRef[]): Effect.Effect<UpstreamToken[], UpstreamError>;
  // One upstream call per ref per range, raw observation points ascending (granularity per upstream; day-normalisation is in the service layer).
  // `vsCurrency` defaults to USD; fiat history derivation passes `<code>` to get "BTC priced in a fiat" through this same call.
  fetchPriceSeries(
    ref: TokenRef,
    fromMs: number,
    toMs: number,
    vsCurrency?: string,
  ): Effect.Effect<TokenPricePoint[], UpstreamError>;
}

// Global map face: the whole "on-chain ref to this source's name" set; cron once a day.
export interface TokenRefIndexUpstream extends UpstreamIdentity {
  fetchRefIndex(): Effect.Effect<RefIndexFetch, UpstreamError>;
}

// The full token upstream = the intersection of the three faces. The only implementation is the CoinGecko adapter.
export type TokenUpstream = TokenMetaUpstream & PriceUpstream & TokenRefIndexUpstream;

// Fx face (display currencies): fetched whole, no per-currency lookup (a dozen currencies, one upstream call returns all).
// A separate port, not a face of `TokenUpstream`: rates are unrelated to "which token is this" and may come from another vendor.
export interface FxUpstream extends UpstreamIdentity {
  // Currency code (uppercase) to usdPerUnit; currencies upstream does not know are absent (not an error).
  fetchRates(): Effect.Effect<Map<string, number>, UpstreamError>;

  // BTC's tokenRef in this source: the BTC base of rate derivation (`fetchRates` is BTC-derived; history likewise:
  // `usd_per_unit(code)@day = BTC/USD@day / BTC/code@day`, both legs via `PriceUpstream.fetchPriceSeries(btcRef, …, vsCurrency)`).
  // It is also the key of the BTC/USD history leg in `token_daily_prices`, sharing rows with `tokens.priceSeries`.
  readonly btcRef: TokenRef;
}

// Platform face (chain names and logos), an independent port. Only the whole chain table, no per-key lookup (one endpoint returns all).
export interface PlatformUpstream extends UpstreamIdentity {
  // Each chain yields a short slug; one with a numeric chainId also yields `evm:<id>` (both platformKey forms covered).
  fetchChains(): Effect.Effect<PlatformMeta[], UpstreamError>;
}

// A token as upstream gives it: its own naming + metadata + (maybe) price. Unlike `TokenInfo` it is not in the db yet, so no internal id and `ref` is non-empty.
// `marketCapRank` is independent of `price`: markets gives both, but `/search` gives rank without price, so rank must sit at this top level.
// The display side (picker badge) always reads it here.
export interface UpstreamToken {
  ref: TokenRef;
  symbol: string;
  name: string;
  logo?: string;
  marketCapRank?: number;
  price?: TokenPrice;
}

// Result of pulling the whole map. A mismatch must be reported: a chain we asked for missing from upstream's platform table would
// leave that chain's tokens with no price or logo and no error (a silent failure needs an outlet).
export interface RefIndexFetch {
  rows: TokenRefIndexRow[];
  unmatchedPlatforms: string[]; // chains we asked for that upstream lacks: warn
  skipped: number; // chains upstream has that we do not track: a plain count, normal and large
}
