import { env } from "cloudflare:workers";
import {
  type CurrentUser,
  type Database,
  type DbClient,
  type DbRequest,
  databaseTickets,
  type GlobalDatabase,
  provideCurrentUser,
  provideDbClient,
} from "@folio/db";
import type { OracleServices } from "@folio/oracle";
import { Context, Effect, Layer, Runtime, Scope } from "effect";
import type { JsonResponse } from "@/lib/core/json-response";
import { type ConnectorRegistry, connectorRegistryContext } from "./connectors/registry";
import { logCategory, withLogTapeLogger } from "./effect-log";
import { type AppError, toError } from "./errors";
import { type Enqueued, enqueue } from "./jobs/queue";
import { oracleServices } from "./oracle";
import { withSpanTree } from "./tracing";

/**
 * Adds an info log with handler name and duration (TanStack paths are REDACTED in Workers logs).
 * `durationMs` is I/O wall-clock, not CPU: workerd freezes `performance.now()` during synchronous compute.
 */
const withServerFnTiming =
  <A, E extends AppError>(handler: string) =>
  (effect: Effect.Effect<A, E, UserServices>): Effect.Effect<A, E, UserServices> =>
    // Both `Effect.suspend`s are required: pipe/ensuring arguments are evaluated at build time, so
    // without them both `performance.now()` calls fire together and durationMs is always ~0.
    Effect.suspend(() => {
      const startedAt = performance.now();
      return effect.pipe(
        Effect.annotateLogs({ handler }),
        Effect.ensuring(
          Effect.suspend(() =>
            Effect.logInfo("server fn").pipe(
              logCategory("server-fn"),
              Effect.annotateLogs({
                handler,
                durationMs: Number((performance.now() - startedAt).toFixed(1)),
              }),
            ),
          ),
        ),
      );
    });

/** Built once per isolate; holds nothing request- or user-specific (no fiber, timer or I/O handle). */
type IsolateServices = Database | OracleServices | ConnectorRegistry | GlobalDatabase;

/** The db-only half; cron and note pruning need nothing more. */
type DbServices = Database | GlobalDatabase;

/**
 * Lazy: nothing runs at module load (Workers startup CPU limit). Two runtimes because building the
 * whole graph via Layer costs ~45 ms CPU on a cold isolate, mostly Layer machinery.
 *   - `dbRuntime`: hand-assembled db tickets + log forwarder; used by cron, note pruning and the edge.
 *   - `isolateRuntime`: adds the oracle and connector tickets on first need. `GlobalDatabase` exists
 *     twice (oracleServices brings its own, merge picks it); both are stateless, never compare by reference.
 * Never disposed: nothing in them needs teardown.
 */
let dbOnly: Runtime.Runtime<DbServices> | undefined;
const dbRuntime = (): Runtime.Runtime<DbServices> => {
  dbOnly ??= Runtime.make({
    context: databaseTickets(),
    fiberRefs: withLogTapeLogger(Runtime.defaultRuntime.fiberRefs),
    runtimeFlags: Runtime.defaultRuntime.runtimeFlags,
  });
  return dbOnly;
};

/**
 * `dbRuntime` context + connector ticket + oracle layer. The oracle half must go through Layer but
 * is built once, synchronously: `runSync` asserts that, so an I/O-bound layer fails loudly here.
 */
let isolate: Runtime.Runtime<IsolateServices> | undefined;
const isolateRuntime = (): Runtime.Runtime<IsolateServices> => {
  if (isolate) return isolate;
  const base = dbRuntime();
  const oracle = Effect.runSync(
    Effect.flatMap(Scope.make(), (scope) => Layer.buildWithScope(oracleServices(), scope)),
  );
  isolate = Runtime.make({
    context: base.context.pipe(Context.merge(oracle), Context.merge(connectorRegistryContext())),
    fiberRefs: base.fiberRefs,
    runtimeFlags: base.runtimeFlags,
  });
  return isolate;
};

/**
 * Everything a handler's `R` may use. Oracle token/price rows are deliberately absent so no handler
 * can bypass the oracle to write them (`user-services-surface.test.ts` pins this).
 */
export type UserServices = Database | OracleServices | ConnectorRegistry | DbRequest | UserJobs;

/**
 * Lets a handler enqueue jobs for the current user without seeing the userId. The Tag stays in this
 * file, like `CurrentUser`, so nobody can enqueue messages on behalf of an arbitrary user.
 */
class UserJobs extends Context.Tag("web/UserJobs")<
  UserJobs,
  { readonly enqueue: (build: (userId: string) => readonly Enqueued[]) => Effect.Effect<void> }
>() {}

export type { UserJobs };

export const enqueueForUser = (
  build: (userId: string) => readonly Enqueued[],
): Effect.Effect<void, never, UserJobs> => Effect.flatMap(UserJobs, (jobs) => jobs.enqueue(build));

/**
 * Gives the effect its user and exactly one `DbClient`: every op inside shares that handle.
 * This is the only place the app provides a user.
 */
const asUser =
  (userId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(UserJobs, { enqueue: (build) => enqueue(build(userId)) }),
      provideCurrentUser(userId),
      provideDbClient(env),
    );

// Annotations wrap outside `asUser` so logs from the injection step carry the userId.
const inRequest = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Error, Exclude<Exclude<Exclude<R, UserJobs>, CurrentUser>, DbClient>> =>
  effect.pipe(
    asUser(userId),
    Effect.mapError(toError),
    Effect.annotateLogs({ userId }),
    Effect.annotateSpans({ userId }),
  );

/** An assembled-but-unrun effect, for cron to compose N users into one effect and run it once at the edge. */
export const forUser = <A, E extends AppError>(
  userId: string,
  effect: Effect.Effect<A, E, UserServices>,
): Effect.Effect<A, Error> => Effect.provide(inRequest(userId, effect), isolateRuntime());

/** `forUser` for db-only effects: skips building the oracle / connector half on a cold isolate. */
export const forUserDb = <A, E extends AppError>(
  userId: string,
  effect: Effect.Effect<A, E, Database | DbRequest | UserJobs>,
): Effect.Effect<A, Error> => Effect.provide(inRequest(userId, effect), dbRuntime());

/** Launch point for routes and tests; server fns go through `runEffect`. Routes authenticate with `resolveAuth` instead of the middleware. */
export const runForUser = <A, E extends AppError>(
  userId: string,
  effect: Effect.Effect<A, E, UserServices>,
): Promise<A> =>
  // The span tree is installed here, not in `forUser`: cron composes N users into one effect and installs it at its edge.
  Runtime.runPromise(isolateRuntime())(withSpanTree(inRequest(userId, effect)));

/**
 * Launch point for server fns: the handler only describes, this decides user, assembly, error mapping
 * and Promise conversion. The `handler` log annotation comes from the function name, which
 * `Effect.fn("name")` keeps as a string constant that minification can't rename.
 */
export const runEffect =
  <D, A, E extends AppError>(handler: (data: D) => Effect.Effect<A, E, UserServices>) =>
  // Declares only `userId`: the rest of the injected `AuthContext` should stay out of handlers' reach.
  ({ data, context }: { data: D; context: { userId: string } }): Promise<A> => {
    const name = handler.name || "anonymous";
    const effect = withServerFnTiming<A, E>(name)(handler(data));
    return runForUser(context.userId, effect);
  };

/** `runEffect` variant for pure-JSON reads: skips seroval and writes the Response with native `JSON.stringify`. */
export const runEffectJson =
  <D, A, E extends AppError>(handler: (data: D) => Effect.Effect<A, E, UserServices>) =>
  async (ctx: { data: D; context: { userId: string } }): Promise<JsonResponse<A>> => {
    const value = await runEffect(handler)(ctx);
    return new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    }) as JsonResponse<A>;
  };

/** System-level work without a user (cron enumerating users); `R` has no `CurrentUser`. */
export const withGlobalDb = <A, E>(
  effect: Effect.Effect<A, E, GlobalDatabase | DbClient>,
): Effect.Effect<A, E> => Effect.provide(provideDbClient(env)(effect), dbRuntime());

/** Runs an already-assembled effect on `dbRuntime`; effects needing the oracle / connectors bring `isolateRuntime` via `forUser`. */
export const runAtEdge = <A>(effect: Effect.Effect<A, Error>): Promise<A> =>
  // Cron is one trip, so the span tree covers the whole run (debug only).
  Runtime.runPromise(dbRuntime())(withSpanTree(effect));
