import { Effect } from "effect";
import { type DbEnv, type Drizzle, getDb } from "./connect";

type Stmt = Parameters<Drizzle["batch"]>[0][number];

// The only Promise-to-Effect bridge: one place to add spans or slow-query logging.
// `query` runs one drizzle builder (read or single write); `batch` is one D1 batch (D1 has no interactive transactions).
// `chunk` is here because D1 caps bound parameters per statement, a hard limit like the transaction one.
// Error channel is `never`: a D1 outage is a defect that surfaces as a 500, nothing handles it.
// Takes a handle, not env, so the D1 binding and the Node SQL proxy (./remote.ts) share the same bridge.
export const connectTo = (db: Drizzle) => {
  return {
    // Span lives here; `database.ts` `bindPerCall` adds the op-level name (e.g. `accounts.create`).
    //
    // `withSpan` + `captureStackTrace: false`, not `Effect.fn`: Effect.fn captures a call-site Error per call (~1ms per snapshot read).
    query: <A>(build: (d: Drizzle) => PromiseLike<A>): Effect.Effect<A> =>
      Effect.withSpan(
        Effect.promise(() => build(db)),
        "db.query",
        { captureStackTrace: false },
      ),

    // Takes a builder, not a prebuilt statement, so callers never pull `db` out of the service. drizzle needs a non-empty tuple; empty is a no-op. `build(db)` is in `suspend` so statements are built at run time.
    batch: (build: (d: Drizzle) => readonly Stmt[]): Effect.Effect<void> =>
      Effect.withSpan(
        Effect.suspend(() => {
          const [first, ...rest] = build(db);
          return first
            ? Effect.asVoid(Effect.promise(() => db.batch([first, ...rest])))
            : Effect.void;
        }),
        "db.batch",
        { captureStackTrace: false },
      ),
  };
};

const connect = (env: DbEnv) => connectTo(getDb(env));

export class DbClient extends Effect.Service<DbClient>()("db/DbClient", {
  effect: (env: DbEnv) => Effect.sync(() => connect(env)),
}) {}

export const provideDbClient =
  (env: DbEnv) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, DbClient>> =>
    Effect.provideServiceEffect(
      self,
      DbClient,
      Effect.sync(() => DbClient.make(connect(env))),
    );

// D1 allows ~100 bound parameters per statement, so list queries (`WHERE k IN (...)`) must be chunked; default 90 leaves room for fixed bindings, other shapes pass their own `size`.
const IN_CHUNK = 90;

export function chunk<T>(arr: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
