import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Trezor Blockbook v2 responses (only the fields used). Amounts are always satoshi strings. Types derive from the schema, so an
// upstream shape change is an `UpstreamParseError` on the spot.

// One derived address of an xpub (carries balance with details=tokenBalances; tokens=used gives used addresses only).
export const XpubToken = Schema.Struct({
  name: Schema.String, // address
  path: Schema.String, // derivation path m/purpose'/0'/0'/chain/index
  transfers: Schema.Number,
  balance: Schema.String, // confirmed (satoshi string)
  totalReceived: maybe(Schema.String),
  totalSent: maybe(Schema.String),
});
export type XpubToken = typeof XpubToken.Type;

// GET /api/v2/xpub/{token}?details=tokenBalances&tokens=used: server-side derivation + totals.
export const XpubResponse = Schema.Struct({
  address: Schema.String, // echoed xpub/descriptor
  balance: Schema.String, // account confirmed total (satoshi string, summed by Blockbook)
  unconfirmedBalance: Schema.String, // account net unconfirmed (satoshi string)
  // Optional: display/count extras whose absence must not fail the whole balance parse.
  unconfirmedTxs: maybe(Schema.Number),
  txs: maybe(Schema.Number),
  usedTokens: maybe(Schema.Number),
  tokens: maybe(Schema.Array(XpubToken)), // used derived addresses (with balance)
});
export type XpubResponse = typeof XpubResponse.Type;

// GET /api/v2/xpub/{token}?details=basic: account summary only (liveness probe, no per-address detail).
// Not the same shape as above: the basic tier has no `unconfirmedBalance` (tokens and above do), so sharing one schema made every
// probe fail at parsing; this one lists only the fields basic really returns.
export const XpubSummary = Schema.Struct({
  address: Schema.String,
  balance: Schema.String,
  unconfirmedTxs: maybe(Schema.Number),
  txs: maybe(Schema.Number),
  usedTokens: maybe(Schema.Number),
});
export type XpubSummary = typeof XpubSummary.Type;

// GET /api/v2/address/{addr}
export const AddressResponse = Schema.Struct({
  address: Schema.String,
  balance: Schema.String,
  unconfirmedBalance: Schema.String,
  unconfirmedTxs: maybe(Schema.Number),
  txs: maybe(Schema.Number),
});
export type AddressResponse = typeof AddressResponse.Type;
