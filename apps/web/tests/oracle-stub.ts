import { type DbEnv, type DbRequest, provideCurrentUser, provideDbClient } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

// Shared test harness for app-side server logic: provides a fake aggregate `Oracle` layer.
// Default methods are empty (empty Map / `none` / 0) so a case only stubs what it cares about.
// Empty stubs are typed against the real interface minus the runtime-unused `_tag` brand, so
// method signatures are still checked against the real service.
type StubOf<S> = Omit<S, "_tag">;

const emptyTokens: StubOf<Oracle["Service"]["tokens"]> = {
  mint: () => Effect.succeed(new Map()),
  enrich: () => Effect.succeed(new Map()),
  enrichAll: () => Effect.succeed(new Map()),
  logoUrlById: () => Effect.succeed(Option.none()),
  pricesOf: () => Effect.succeed(new Map()),
  priceByRef: () => Effect.succeed(Option.none()),
  pricesByRefs: () => Effect.succeed(new Map()),
  refreshStale: () => Effect.succeed({ prices: 0, infos: 0, degraded: false }),
  priceSeries: () => Effect.succeed([]),
  priceAt: () => Effect.succeed(Option.none()),
  fillDaily: () => Effect.succeed({ calls: 0, done: true, failed: false }),
  topTokens: () => Effect.succeed([]),
  search: () => Effect.succeed([]),
  refreshCatalogue: () => Effect.succeed(0),
};

const emptyFx: StubOf<Oracle["Service"]["fx"]> = {
  resolve: () => Effect.succeed(Option.none()),
  warm: () => Effect.void,
  rateSeries: () => Effect.succeed([]),
  fillDaily: () => Effect.succeed({ calls: 0, done: true, failed: false }),
};

const emptyPlatforms: StubOf<Oracle["Service"]["platforms"]> = {
  resolve: (keys) => Effect.succeed(new Map([...keys].map((key) => [key, { key, name: key }]))),
  warm: () => Effect.void,
};

export interface OracleStub {
  tokens?: Partial<Oracle["Service"]["tokens"]>;
  fx?: Partial<Oracle["Service"]["fx"]>;
  platforms?: Partial<Oracle["Service"]["platforms"]>;
}

// The only `as`: fills in the three `_tag`s omitted by `StubOf`; signatures are already checked.
const oracleStubLayer = (stub: OracleStub = {}) =>
  Layer.succeed(
    Oracle,
    Oracle.of({
      tokens: { ...emptyTokens, ...stub.tokens },
      fx: { ...emptyFx, ...stub.fx },
      platforms: { ...emptyPlatforms, ...stub.platforms },
    } as Oracle["Service"]),
  );

/**
 * Provides the per-request user + DB client the types require. The stub reads neither; the client
 * is an empty object, so a query reaching it blows up in drizzle, exposing a missing stub method.
 */
export const stubRequest = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(provideCurrentUser("stub-user"), provideDbClient({ DB: {} } as DbEnv));

// Runs an effect that uses the oracle and returns a Promise.
export const runWithOracle = <A, E>(
  stub: OracleStub,
  effect: Effect.Effect<A, E, Oracle | DbRequest>,
): Promise<A> => Effect.runPromise(stubRequest(Effect.provide(effect, oracleStubLayer(stub))));

// Same, with the clock pinned to a fixed time, for cases that read `Clock` (e.g. `asOf`).
export const runWithOracleAt = <A, E>(
  nowMs: number,
  stub: OracleStub,
  effect: Effect.Effect<A, E, Oracle | DbRequest>,
): Promise<A> =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(nowMs), effect).pipe(
      Effect.provide(oracleStubLayer(stub)),
      stubRequest,
      Effect.provide(TestClock.layer()),
    ),
  );
