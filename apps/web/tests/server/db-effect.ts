import { env } from "cloudflare:test";
import {
  Database,
  DatabaseForOracle,
  type DbClient,
  type DbRequest,
  GlobalDatabase,
  provideCurrentUser,
  provideDbClient,
} from "@folio/db";
import { COINGECKO_ID } from "@folio/upstreams";
import { Effect, Layer } from "effect";

// Fixture helpers for workers-pool tests that insert rows into D1 and read them back.
// Each op gets `provideDbClient(env)` (real D1, Miniflare) and `provideCurrentUser` at run time.

const runWith = <I, A>(
  layer: Layer.Layer<I>,
  userId: string,
  effect: Effect.Effect<A, never, I | Database | DbRequest>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer),
      Effect.provide(Database.layer),
      provideCurrentUser(userId),
      provideDbClient(env),
    ),
  );

// Promise-shaped per-user fixture helpers: these cases check persisted data, not timing. Each call provides
// the same layer then `runPromise`, one independent D1 operation per call.
type Promisified<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _R>
    ? (...args: A) => Promise<R>
    : S[K];
};

// Service lookup and runner are passed separately: per-user uses `runWith` (needs a userId),
// global uses `runGlobal` (no userId).
const promisifiedFrom = <S extends object, R>(
  service: Effect.Effect<S, never, R>,
  run: <A>(effect: Effect.Effect<A, never, R>) => Promise<A>,
): Promisified<S> =>
  new Proxy({} as Promisified<S>, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        run(
          Effect.flatMap(service, (resolved) => {
            const method = (resolved as Record<string | symbol, unknown>)[key];
            if (typeof method !== "function") {
              throw new TypeError(`not a method on the service: ${String(key)}`);
            }
            return (method as (...a: unknown[]) => Effect.Effect<unknown>).apply(resolved, args);
          }),
        ),
  });

/** Per-user store helpers via the aggregate `Database`: `dbFor(USER).accounts.list()`. */
export const dbFor = (userId: string) => {
  const of = <S extends object>(pick: (db: Database["Service"]) => S) =>
    promisifiedFrom(Effect.map(Database, pick), (effect) => runWith(Layer.empty, userId, effect));
  return {
    accounts: of((db) => db.accounts),
    portfolios: of((db) => db.portfolios),
    settings: of((db) => db.settings),
    snapshots: of((db) => db.snapshots),
    manual: of((db) => db.manual),
    tags: of((db) => db.tags),
    tabPins: of((db) => db.tabPins),
    transfer: of((db) => db.transfer),
    cache: of((db) => db.cache),
  };
};

/** Fixture helpers for the oracle service (not on `Database`): `oracleDbFor(USER).tokens.create(...)`. */
export const oracleDbFor = (userId: string) => {
  const of = <S extends object>(pick: (db: DatabaseForOracle["Service"]) => S) =>
    promisifiedFrom(Effect.map(DatabaseForOracle, pick), (effect) =>
      runWith(DatabaseForOracle.layer(COINGECKO_ID), userId, effect),
    );
  return {
    tokens: of((db) => db.tokens),
    tokenPrices: of((db) => db.tokenPrices),
  };
};

// Runs an effect needing only `GlobalDatabase`: its ops have no owner, so there is no `CurrentUser` to provide.
const runGlobal = <A>(effect: Effect.Effect<A, never, GlobalDatabase | DbClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(GlobalDatabase.layer), provideDbClient(env)));

/** Fixture helpers for the global (user-less) tables: `globalDb.refIndex.putAll(...)`. */
export const globalDb = {
  refIndex: promisifiedFrom(
    Effect.map(GlobalDatabase, (db) => db.refIndex),
    runGlobal,
  ),
  accounts: promisifiedFrom(
    Effect.map(GlobalDatabase, (db) => db.accounts),
    runGlobal,
  ),
};
