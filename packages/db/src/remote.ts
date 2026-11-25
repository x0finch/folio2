import { drizzle } from "drizzle-orm/sqlite-proxy";
import { Effect } from "effect";
import { connectTo, DbClient } from "./client";
import type { Drizzle } from "./connect";

// SQL-proxy connection for Node jobs (no D1 binding): they supply a transport (`RemoteSql`) and get the same `DbClient`, so diff/batch logic stays in `putAll`. Never exposes the drizzle handle.

export type RemoteMethod = "run" | "all" | "values" | "get";

export interface RemoteStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly method: RemoteMethod;
}

/**
// Rows are value arrays in SELECT column order (D1 REST `/raw` and `node:sqlite` setReturnArrays both give this); drizzle maps by position, so duplicate column names don't collide. Failure rejects and is a defect.
 */
export interface RemoteSql {
  query(stmt: RemoteStatement): Promise<unknown[][]>;
  /** One batch: one transaction, run in order (D1 batch semantics); results match statements one to one. */
  batch(stmts: readonly RemoteStatement[]): Promise<unknown[][][]>;
}

// drizzle's `get` wants the single row (undefined if none); the rest want arrays.
const shape = (method: RemoteMethod, rows: unknown[][]) => ({
  rows: method === "get" ? rows[0] : rows,
});

// Type concession: the proxy driver handle is shape-identical to D1's except `.run()`'s raw result (D1 has `meta`), which nothing in the package reads.
const proxyDrizzle = (remote: RemoteSql): Drizzle =>
  drizzle(
    async (sql, params, method) => shape(method, await remote.query({ sql, params, method })),
    async (stmts) => {
      const results = await remote.batch(stmts);
      return stmts.map((s, i) => shape(s.method, results[i] ?? []));
    },
  ) as unknown as Drizzle;

export const provideRemoteDbClient =
  (remote: RemoteSql) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, DbClient>> =>
    Effect.provideServiceEffect(
      self,
      DbClient,
      Effect.sync(() => DbClient.of(connectTo(proxyDrizzle(remote)))),
    );
