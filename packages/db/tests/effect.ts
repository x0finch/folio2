import { env } from "cloudflare:test";
import { Effect, TestClock, TestContext } from "effect";
import { type DbClient, provideDbClient } from "../src/client";
import { provideCurrentUser } from "../src/current-user";
import { Database, DatabaseForOracle, type DbRequest, GlobalDatabase } from "../src/database";

// Shared harness for these stores' tests, running the production path: ticket layer, then Tag, with connection and user read at op time over real D1 (Miniflare); only the clock is fake.
//
// The clock is fake because TTL / stale logic uses `Clock` and tests assert exact values like now + ttl.
export const NOW = 1000;

// Runs an effect that needs only `DbClient`; not exported: cases get services via `forDomain` / `forGlobal` / `forOracle`.
const runDb = <A>(effect: Effect.Effect<A, never, DbClient>, nowMs = NOW): Promise<A> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(nowMs), effect).pipe(
      provideDbClient(env),
      Effect.provide(TestContext.TestContext),
    ),
  );

// Promise handle for a service, so cases can `await store.create(...)` directly.
type Promisified<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _R>
    ? (...args: A) => Promise<R>
    : S[K];
};

// Handle for one domain: `forDomain((db) => db.tabPins)` then `tabPins(USER_A).create(...)`. One `Database.Default` serves all users; userId is read at op time from `CurrentUser`.
//
// Cases get services only through the aggregate `Database`, not per-domain Tags.
//
// Tests stay Promise-shaped: they check persistence (real D1, key conflicts, cross-user isolation), not timing.
export const forDomain =
  <S extends object>(pick: (db: Database) => S) =>
  (userId: string, nowMs = NOW): Promisified<S> =>
    promisifiedFrom<S, Database, DbRequest>(
      Effect.map(Database, pick),
      (effect) => effect.pipe(Effect.provide(Database.Default), provideCurrentUser(userId)),
      nowMs,
    );

// Handle for `GlobalDatabase`: no userId parameter, and it can't reach `CurrentUser`, which is exactly how it differs from the per-user half.
export const forGlobal =
  <S extends object>(pick: (db: GlobalDatabase) => S) =>
  (nowMs = NOW): Promisified<S> =>
    promisifiedFrom<S, GlobalDatabase, DbClient>(
      Effect.map(GlobalDatabase, pick),
      (effect) => Effect.provide(effect, GlobalDatabase.Default),
      nowMs,
    );

// Handle for the oracle ticket; `namer` is a constructor parameter (db has no vendor), and most cases use the default.
export const forOracle =
  <S extends object>(pick: (db: DatabaseForOracle) => S) =>
  (userId: string, namer: string, nowMs = NOW): Promisified<S> =>
    promisifiedFrom<S, DatabaseForOracle, DbRequest>(
      Effect.map(DatabaseForOracle, pick),
      (effect) =>
        effect.pipe(Effect.provide(DatabaseForOracle.Default(namer)), provideCurrentUser(userId)),
      nowMs,
    );

// Getting the service is an effect (ticket `T`); who it runs as is a combinator that supplies what the methods need (`U`); `runDb` supplies the remaining `DbClient`.
const promisifiedFrom = <S extends object, T, U>(
  service: Effect.Effect<S, never, T>,
  scope: <A>(effect: Effect.Effect<A, never, T | U>) => Effect.Effect<A, never, DbClient>,
  nowMs = NOW,
): Promisified<S> =>
  new Proxy({} as Promisified<S>, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        runDb(
          scope(
            Effect.flatMap(service, (resolved) => {
              const method = (resolved as Record<string | symbol, unknown>)[key];
              if (typeof method !== "function") {
                throw new TypeError(`not a method on the service: ${String(key)}`);
              }
              return (method as (...a: unknown[]) => Effect.Effect<unknown, never, U>).apply(
                resolved,
                args,
              );
            }),
          ),
          nowMs,
        ),
  });
