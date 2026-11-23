import { Clock, Context, Duration, Effect, Option, RateLimiter, type Scope } from "effect";
import { cursorFor } from "./slot-cursor";

// Outbound rate gate; returns Effect's own `RateLimiter`, so its combinators compose.
// Scopes decide where the bucket lives:
//   · `isolated` (default) — shared across CF Workers isolates via the Cache API. That store holds
//     one value with no atomic read-modify-write, hence GCRA (a single cursor), not a semaphore.
//   · `memory` — delegates to the built-in in-process limiter. Tests / single-process only.
//   · `none` — pass-through, for tests that aren't about rate limiting. Never in production.
export type RateLimitScope = "memory" | "isolated" | "none";

export interface RateLimitOptions extends RateLimiter.RateLimiter.Options {
  // What the upstream meters: the key's *name* for a shared API key (never its value — it ends up
  // in logs and cache URLs), a provider constant for per-IP public endpoints, or provider +
  // account id for per-account keys. Skip the gate when nothing contends for the quota.
  readonly key: string;
  // Explicit scope, only for testing the algorithms themselves; otherwise use the override service.
  readonly scope?: RateLimitScope;
}

// Optional service (read via `serviceOption`, so `R` stays clean) to switch scope in tests.
// Unprovided means `isolated` — the single place the default is defined.
export class RateLimitScopeOverride extends Context.Tag("client-core/RateLimitScopeOverride")<
  RateLimitScopeOverride,
  RateLimitScope
>() {}

// Process-wide fallback scope, test-only (setter exported from `/testing`). For tests of real app
// wiring where `runPromise` happens inside the code under test and nothing can be provided.
let scopeDefaultForTests: RateLimitScope | undefined;

export const setScopeDefaultForTests = (scope: RateLimitScope | undefined): void => {
  scopeDefaultForTests = scope;
};

// Defaults to `isolated`: on Workers an in-process bucket resets with every new isolate.
const scopeFor = (explicit?: RateLimitScope): Effect.Effect<RateLimitScope> =>
  explicit !== undefined
    ? Effect.succeed(explicit)
    : Effect.map(Effect.serviceOption(RateLimitScopeOverride), (o) =>
        Option.isSome(o) ? o.value : (scopeDefaultForTests ?? "isolated"),
      );

// Same signature as `RateLimiter.make` (plus `key`), so the two are interchangeable.
export function make(
  options: RateLimitOptions,
): Effect.Effect<RateLimiter.RateLimiter, never, Scope.Scope> {
  return Effect.flatMap(scopeFor(options.scope), (scope) => {
    if (scope === "memory") return RateLimiter.make(options);
    if (scope === "none") return Effect.succeed(passthrough);
    return isolated(options);
  });
}

const passthrough: RateLimiter.RateLimiter = <A, E, R>(task: Effect.Effect<A, E, R>) => task;

// GCRA over one theoretical-arrival-time cursor: grant = cursor − burst; each grant pushes the
// cursor one spacing; the cursor never trails `now`, so idle time refills the burst.
// Smooths peaks, not strict: strict limiting on Workers needs a Durable Object; 429 + retry
// covers the leak.
// Gaps vs the built-in: `fixed-window` dies at construction (one cursor can't express it), and
// `RateLimiter.withCost` is ignored (its weight lives in an unexported internal FiberRef).
const isolated = (
  options: RateLimitOptions,
): Effect.Effect<RateLimiter.RateLimiter, never, Scope.Scope> =>
  Effect.sync(() => {
    if (options.algorithm === "fixed-window") {
      throw new Error(
        `rate limit "${options.key}": the isolated scope only implements token-bucket (GCRA); ` +
          `fixed-window needs the memory scope`,
      );
    }
    const spacing = Duration.toMillis(Duration.decode(options.interval)) / options.limit;
    const burst = (options.limit - 1) * spacing;
    // Cursor is keyed and shared across `make` calls, not scoped: on Workers each request is its
    // own run, so scoped state would reset per request.
    const cursor = cursorFor(options.key);

    return <A, E, R>(task: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const tat = yield* cursor.advance(spacing, now);
        const waitMs = tat - burst - now;
        if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
        return yield* task;
      });
  });
