import type { TokenRef } from "@folio/oracle-ref";

// Domain types of the reference layer. `asset` = the input side of a holding (identity to resolve); `token` = everything after resolution.
// No data source is named: who calls it what is the tokenRef's `namer`, reported by the injected upstream. Internally only
// `tokens.id` counts; `tokenRef` appears only at the two boundaries (connector balances, oracle asking upstream). "Did upstream recognise
// it" is not a state: it is whether the namer's ref row exists, i.e. `TokenInfo.ref` non-null.

export type { TokenRef };

// Two facets (stored separately for different TTLs)

// Metadata facet, slow TTL (logo / name rarely change). `ref` = the current source's name for it; `null` = not recognised yet.
export interface TokenInfo {
  id: string;
  ref: TokenRef | null;
  symbol: string;
  name: string;
  logo?: string; // the source's image (canonical)
  providerLogo?: string; // the connector's own image (spare slot; second tier of the display fallback chain)
  // These three fields are due for refetch (long TTL, see INFO_TTL_MS). Reads do not degrade for it: served as is and flagged,
  // like price stale. Set to "expired" at row creation, since the row was built from connector metadata upstream has not overwritten.
  infoStale: boolean;
}

// Price facet, fast TTL. `marketCapRank` is market data. Always priced in USD; fiat conversion is in the display layer.
export interface TokenPrice {
  unitPrice: number;
  change24h?: number;
  marketCapRank?: number;
  asOf: number;
}

// Price facet read form: expired is not deleted, carries a stale flag (SWR): show the old price and refresh in the background.
export interface TokenRecordPrice extends TokenPrice {
  stale: boolean;
}

// A whole token row = the two facets merged by the service after reading the two stores.
export interface TokenRecord extends TokenInfo {
  price?: TokenRecordPrice;
}

// Write shapes

// Provider-side seed (collected at sync): when creating a row it is everything; when merging into an existing Token it only fills empty slots.
export interface ProviderTokenSeed {
  symbol: string; // normalised (uppercase)
  name?: string;
  providerLogo?: string;
}

// Empty-slot patch: a name / image / rank a source supplies later; undefined fields are untouched.
export interface TokenInfoPatch {
  name?: string;
  logo?: string;
  providerLogo?: string;
}

// Write back one price (by token_id, not ref).
export interface TokenPriceWrite extends TokenPrice {
  tokenId: string;
}

// Write back one row of upstream metadata (by token_id). Unlike `TokenInfoPatch` this overwrites: upstream is the authority for
// these three fields and the connector's values are only provisional. `providerLogo` is not here: upstream may not overwrite it.
export interface TokenInfoWrite {
  tokenId: string;
  symbol: string;
  name: string;
  logo?: string;
}

// Other

// Historical price observation: atMs = start of the UTC day bucket.
export interface TokenPricePoint {
  atMs: number;
  unitPrice: number;
}

// Symbol disambiguation candidate (transient, fed to `pickByConfidence`): from warm, already has `marketCapRank`; the symbol is the lookup key.
export interface TokenCandidate {
  ref: TokenRef;
  marketCapRank?: number;
}

// A ref that already has an owner. `linked` = its Token already has a ref row for the current source, i.e. already recognised;
// mint uses it to tell "nothing to do" from "link / merge", avoiding a global-map lookup per known ref each sync.
export interface TokenRefHit {
  tokenId: string;
  linked: boolean;
}

// One row of the global map (`global_token_ref_index`): an on-chain ref and what that upstream calls it. Both sides are whole tokenRefs;
// the store splits the right side into (upstream, upstream_local_name) columns on write, so callers need not know the namer.
export interface TokenRefIndexRow {
  chainRef: TokenRef; // on-chain address: evm:<chainId>/contract:<addr> / <slug>/contract:<addr>
  upstreamRef: TokenRef; // upstream's whole name for it: coingecko/issued:bitcoin
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
