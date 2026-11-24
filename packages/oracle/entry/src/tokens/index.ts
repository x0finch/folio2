import { DatabaseForOracle, GlobalDatabase } from "@folio/db";
import { Namer, TokenUpstream } from "@folio/oracle-basic/ports";
import { Context, Effect, Layer } from "effect";
import { CandidateSource } from "./candidates";
import { makeCatalogue, type TokenCatalogue } from "./catalogue";
import { makeHistory, type TokenHistory } from "./history";
import { type MintInput, makeMinting, type TokenMinting } from "./mint";
import { makePricing, makeReading, type TokenPricing, type TokenReading } from "./price";
import { makeStaleRefresh, type RefreshStaleReport, type TokenStaleRefresh } from "./stale";

// Token domain facade: one service, five slices. This file only composes the shape and the service.
// Slices split by "who asks, about what"; `mint` is where "which token is this" is fixed and frozen into the snapshot,
// everything else takes a token_id directly.
//   `./mint`       write  tokenRef to token_id, no network (the red line is in the file)
//   `./price`      read   row enrichment + current price (rows with an internal id only read the table)
//   `./history`    read + backfill of daily prices (backfill only in the `daily-prices` job)
//   `./stale`      write  the only place that overwrites existing rows
//   `./catalogue`  read   public token catalogue, touches no store
// Internal pieces, not exported from this index: `./warm` (top-N blob), `./candidates` (mint's symbol-tier source,
// package-internal Tag consumed by `../oracle`), `./swr` (SWR combinator + degradation; domain-neutral, also used by `../fx` and `../platforms`).
// The shape is composed by `extends` so each method's docs stay with its implementation; `TokenServiceShape` only names the `effect` return value.
interface TokenServiceShape
  extends TokenMinting,
    TokenReading,
    TokenPricing,
    TokenHistory,
    TokenStaleRefresh,
    TokenCatalogue {}

export type { MintInput, RefreshStaleReport };

// The global ref-index maintenance lives in `../global-ref-index`, not here: `TokenService` is per-user and
// that job has no userId, so folding it in would force a fake one.

// `CandidateSource` stays on `TokenService.layer`'s `R` and is consumed by `../oracle` at assembly; replacing it needs only another layer.
// Time comes from `Clock` (tests use `TestClock`).
// Services are taken from Tags only here: the slice factories take resolved ports, so their `R` has no services; store ops carry only `DbRequest`.
export class TokenService extends Context.Service<TokenService>()("oracle/TokenService", {
  make: Effect.gen(function* () {
    // Token rows / price rows / cache come from db's reference-layer-only ticket; they are not ports.
    const { tokens: store, tokenPrices: prices, cache } = yield* DatabaseForOracle;
    const upstream = yield* TokenUpstream;

    // The only place mint's extra dependencies share a scope with upstreams; `makeMinting`'s `MintDeps` has none (`./mint` red line).
    const { refIndex: globalRefIndex } = yield* GlobalDatabase;
    const candidates = yield* CandidateSource;
    const namer = yield* Namer;

    // Each slice gets only the ports it needs: `price` enrichment touches no upstream, `catalogue` touches no store.
    return {
      ...makeMinting({ store, globalRefIndex, candidates, namer }),
      ...makeReading(store, prices),
      ...makePricing(prices, upstream),
      ...makeHistory(store, prices, cache, upstream),
      ...makeStaleRefresh(store, prices, upstream),
      ...makeCatalogue(cache, upstream),
    } satisfies TokenServiceShape;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
