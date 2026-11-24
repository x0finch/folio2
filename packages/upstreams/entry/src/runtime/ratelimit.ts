import { Clock, Context, Duration, Effect, Option } from "effect";
import * as RateLimiter from "effect/persistence/RateLimiter";
import { cursorFor } from "./slot-cursor";

// Outbound rate gate: wraps a task so it waits for a slot. Scopes decide where the bucket lives:
//   · `isolated` (default) — shared across CF Workers isolates via the Cache API. That store holds
//     one value with no atomic read-modify-write, hence GCRA (a single cursor), not a semaphore.
//   · `memory` — the same GCRA on a cursor private to this gate. Tests / single-process only.
//   · `none` — pass-through, for tests that aren't about rate limiting. Never in production.
export type RateLimitScope = "memory" | "isolated" | "none";

export type RateLimit = <A, E, R>(task: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

export interface RateLimitOptions {
  readonly limit: number; // grants per interval; also the burst
  readonly interval: Duration.Input;
  // What the upstream meters: the key's *name* for a shared API key (never its value — it ends up
  // in logs and cache URLs), a provider constant for per-IP public endpoints, or provider +
  // account id for per-account keys. Skip the gate when nothing contends for the quota.
  readonly key: string;
  // Explicit scope, only for testing the algorithms themselves; otherwise use the override service.
  readonly scope?: RateLimitScope;
}

// Optional service (read via `serviceOption`, so `R` stays clean) to switch scope in tests.
// Unprovided means `isolated` — the single place the default is defined.
export class RateLimitScopeOverride extends Context.Service<
  RateLimitScopeOverride,
  RateLimitScope
>()("upstreams/RateLimitScopeOverride") {}

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

export function make(options: RateLimitOptions): Effect.Effect<RateLimit> {
  return Effect.map(scopeFor(options.scope), (scope) => {
    if (scope === "none") return passthrough;
    const cursor = scope === "memory" ? memoryCursor() : cursorFor(options.key);
    return gcra(options, cursor);
  });
}

const passthrough: RateLimit = (task) => task;

// `advance` returns the slot granted to this call and moves the cursor one spacing past it.
interface Cursor {
  readonly advance: (spacing: number, now: number) => Effect.Effect<number>;
}

const memoryCursor = (): Cursor => {
  let tat = Number.NEGATIVE_INFINITY;
  return {
    advance: (spacing, now) =>
      Effect.sync(() => {
        const mine = Math.max(tat, now);
        tat = mine + spacing;
        return mine;
      }),
  };
};

// GCRA over one theoretical-arrival-time cursor, served as the token-bucket store of
// `effect/persistence/RateLimiter`: each grant pushes the cursor one spacing, the cursor never
// trails `now`, so idle time refills the burst. The Cache API holds one value with no atomic
// read-modify-write, hence a single cursor rather than a counter. Smooths peaks, not strict:
// strict limiting on Workers needs a Durable Object; 429 + retry covers the leak.
// The isolated cursor is keyed and shared across `make` calls, not scoped: on Workers each request
// is its own run, so scoped state would reset per request.
const unsupported = (what: string) =>
  Effect.die(new Error(`rate limit store: ${what} is not supported`));

const gcraStore = (cursor: Cursor): RateLimiter.RateLimiterStore["Service"] => ({
  tokenBucket: ({ tokens, limit, refillRate }) =>
    Effect.gen(function* () {
      const spacing = Duration.toMillis(refillRate);
      const burst = (limit - 1) * spacing;
      const now = yield* Clock.currentTimeMillis;
      const slot = yield* cursor.advance(spacing * tokens, now);
      const wait = slot - burst - now;
      // Encoded so the limiter's `ceil(-remaining) * refill - elapsed` is exactly `wait`.
      if (wait <= 0) return [Math.floor(-wait / spacing), 0] as const;
      const owed = Math.ceil(wait / spacing);
      return [-owed, owed * spacing - wait] as const;
    }),
  fixedWindow: () => unsupported("fixed-window"),
  adaptiveConsume: () => unsupported("adaptive"),
  adaptiveFeedback: () => unsupported("adaptive"),
});

const gcra = (options: RateLimitOptions, cursor: Cursor): RateLimit => {
  const limiter = RateLimiter.make.pipe(
    Effect.provideService(RateLimiter.RateLimiterStore, gcraStore(cursor)),
    Effect.runSync,
  );
  const consume = limiter.consume({
    algorithm: "token-bucket",
    onExceeded: "delay",
    window: options.interval,
    limit: options.limit,
    key: options.key,
  });
  return <A, E, R>(task: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    consume.pipe(
      // The store never fails, and "delay" never reports an excess.
      Effect.orDie,
      Effect.flatMap(({ delay }) => (Duration.isZero(delay) ? Effect.void : Effect.sleep(delay))),
      Effect.andThen(task),
    );
};
