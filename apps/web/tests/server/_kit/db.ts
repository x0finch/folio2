import { env } from "cloudflare:test";
import { Database, type DbRequest, provideCurrentUser, provideDbClient } from "@folio/db";
import { Effect } from "effect";

// Fixture-side DB handle: the aggregate `Database` domain ops wrapped as Promises, each run against the
// same `Database` layer + real D1. Code under test goes through `call()` instead.

type Promisified<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _R>
    ? (...args: A) => Promise<R>
    : S[K];
};

const runOnce = <A>(
  userId: string,
  effect: Effect.Effect<A, never, Database | DbRequest>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Database.Default), provideCurrentUser(userId), provideDbClient(env)),
  );

const promisify = <S extends object>(userId: string, pick: (db: Database) => S): Promisified<S> =>
  new Proxy({} as Promisified<S>, {
    get:
      (_t, key) =>
      (...args: unknown[]) =>
        runOnce(
          userId,
          Effect.flatMap(Effect.map(Database, pick), (svc) => {
            const method = (svc as Record<string | symbol, unknown>)[key];
            if (typeof method !== "function") {
              throw new TypeError(`Not a method on this domain: ${String(key)}`);
            }
            // Fixtures only use infallible ops; fallible ones go through `call` in the test.
            return (method as (...a: unknown[]) => Effect.Effect<unknown>).apply(svc, args);
          }) as Effect.Effect<unknown, never, Database | DbRequest>,
        ),
  });

export const db = (userId: string) => ({
  accounts: promisify(userId, (d) => d.accounts),
  portfolios: promisify(userId, (d) => d.portfolios),
  settings: promisify(userId, (d) => d.settings),
  snapshots: promisify(userId, (d) => d.snapshots),
  manual: promisify(userId, (d) => d.manual),
  tags: promisify(userId, (d) => d.tags),
  tabPins: promisify(userId, (d) => d.tabPins),
  cache: promisify(userId, (d) => d.cache),
  syncRounds: promisify(userId, (d) => d.syncRounds),
});

/** Raw row count, for "nothing was written" assertions the domain ops can't see. */
export const countRows = async (table: string, userId: string): Promise<number> => {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};
