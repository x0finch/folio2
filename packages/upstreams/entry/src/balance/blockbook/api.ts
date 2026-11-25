import type { UpstreamError } from "@folio/upstream-basic";
import { Effect, Schema } from "effect";
import type { Call } from "../../runtime/define";
import type { Outbound } from "../../runtime/http";
import { maybe } from "../../runtime/schema";
import { XPUB_DETAILS, XPUB_SUMMARY_DETAILS, XPUB_TOKENS } from "./constants";

// Blockbook v2, only the fields we read. Amounts are satoshi strings.

// One used derived address of an xpub.
export const XpubToken = Schema.Struct({
  name: Schema.String, // address
  path: Schema.String, // m/purpose'/0'/0'/chain/index
  transfers: Schema.Number,
  balance: Schema.String, // confirmed
  totalReceived: maybe(Schema.String),
  totalSent: maybe(Schema.String),
});
export type XpubToken = typeof XpubToken.Type;

const XpubResponse = Schema.Struct({
  address: Schema.String, // the echoed xpub / descriptor
  balance: Schema.String, // confirmed account total
  unconfirmedBalance: Schema.String, // net unconfirmed
  // Display extras: their absence must not fail the balance.
  unconfirmedTxs: maybe(Schema.Number),
  txs: maybe(Schema.Number),
  usedTokens: maybe(Schema.Number),
  tokens: maybe(Schema.Array(XpubToken)),
});

// The basic tier has no `unconfirmedBalance`, so it can't share `XpubResponse`.
const XpubSummary = Schema.Struct({
  address: Schema.String,
  balance: Schema.String,
  unconfirmedTxs: maybe(Schema.Number),
  txs: maybe(Schema.Number),
  usedTokens: maybe(Schema.Number),
});

const AddressResponse = Schema.Struct({
  address: Schema.String,
  balance: Schema.String,
  unconfirmedBalance: Schema.String,
  unconfirmedTxs: maybe(Schema.Number),
  txs: maybe(Schema.Number),
});

// Module-level so not every sync starts at the same node; a `Scope` would restart it per request
// on Workers.
let cursor = 0;

// Another node may answer a rate limit or an outage; a refused request (bad xpub), rejected
// credentials or an unreadable body fail the same everywhere.
const shouldTryNextNode = (error: UpstreamError): boolean =>
  error._tag === "UpstreamRateLimitError" || error._tag === "UpstreamUnavailableError";

// Switching node is this upstream's retry, so it stays out of `Effect.retry`; recursion rather than
// `Effect.firstSuccessOf`, which would go on after any failure.
const request = <A, I>(
  call: Call,
  path: string,
  schema: Schema.Codec<A, I>,
  query?: Record<string, string>,
): Effect.Effect<A, UpstreamError, Outbound> => {
  const attempt = (left: number, at: number): Effect.Effect<A, UpstreamError, Outbound> =>
    call.nodes[at % call.nodes.length](path, schema, { query }).pipe(
      Effect.catch((error) =>
        left > 1 && shouldTryNextNode(error) ? attempt(left - 1, at + 1) : Effect.fail(error),
      ),
    );
  return Effect.suspend(() => attempt(call.nodes.length, cursor++));
};

// `encodeURIComponent` leaves parentheses, and some nodes misparse a descriptor's `tr(…)` raw.
// The xpub sits in the pathname and so reaches the error's `where`: it is stored as public, but
// don't copy it into logs again.
const encodePath = (s: string): string =>
  encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");

export const xpub = (call: Call, token: string) =>
  request(call, `/xpub/${encodePath(token)}`, XpubResponse, {
    details: XPUB_DETAILS,
    tokens: XPUB_TOKENS,
  });

export const xpubSummary = (call: Call, token: string) =>
  request(call, `/xpub/${encodePath(token)}`, XpubSummary, { details: XPUB_SUMMARY_DETAILS });

export const address = (call: Call, addr: string) =>
  request(call, `/address/${encodePath(addr)}`, AddressResponse);
