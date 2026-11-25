import type { DatabaseForOracle, GlobalDatabase } from "@folio/db";
import type { Namer } from "@folio/oracle-basic/ports";
import type { FxUpstream, PlatformUpstream, TokenUpstream } from "@folio/upstream-basic/ports";
import { Context, Effect, Layer } from "effect";
import { FxService } from "./fx";
import { PlatformService } from "./platforms";
import { TokenService } from "./tokens";
import { CandidateSource } from "./tokens/candidates";

// Assembly of the per-user reference layer from three domain services (tokens / fx / platforms). Methods carry `DbRequest`
// in `R`, so an effect without a user does not compile; the services are built once per isolate and capture only tickets
// and upstreams, nothing request- or user-specific.

/**
 * The one per-user ticket: `(yield* Oracle).fx.resolve("EUR")`, mirroring `@folio/db`'s aggregate `Database`.
 * The domain services are unchanged; `tokens.mint` is `TokenService.mint` itself.
 */
export class Oracle extends Context.Service<Oracle>()("oracle/Oracle", {
  make: Effect.gen(function* () {
    return {
      tokens: yield* TokenService,
      fx: yield* FxService,
      platforms: yield* PlatformService,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

// Also contains the aggregate: `yield* Oracle` works once `oracleLayer` is provided; domain services stay individually gettable.
export type OracleServices = Oracle | TokenService | FxService | PlatformService;

// All ports the three services need.
export type OraclePorts =
  // The local stores come from `@folio/db`'s two tickets and are not ports. `DatabaseForOracle` (token / price rows,
  // cache) is reference-layer only; `GlobalDatabase` is the global ref-index table mint looks up (no userId).
  DatabaseForOracle | GlobalDatabase | TokenUpstream | FxUpstream | PlatformUpstream | Namer;

// `CandidateSource` is consumed here: package-internal Tag that must not appear in the assembly point's `R`.
const domains = Layer.mergeAll(
  Layer.provide(TokenService.layer, CandidateSource.layer),
  FxService.layer,
  PlatformService.layer,
);

// `provideMerge` keeps the three domain services exposed alongside the aggregate, and both paths must yield the same instance.
export const oracleLayer: Layer.Layer<OracleServices, never, OraclePorts> = Layer.provideMerge(
  Oracle.layer,
  domains,
);
