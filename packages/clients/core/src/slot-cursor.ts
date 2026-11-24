import { Context, Effect, Option, Semaphore } from "effect";

// State for the `isolated` scope: one slot cursor (a number) per key, mirrored to the Cache API
// so isolates share progress.
// Within an isolate the whole grab is serialized by a semaphore, not just the `tat` update: the
// first `seed` is async, and without the lock a cold isolate leaks a burst. Waiting for the slot
// happens outside the lock. Cross-isolate atomicity is impossible and not required (429 + retry).

export interface SlotCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

// Optional service (`R` stays clean). Production falls back to `globalThis.caches`.
export class SlotCacheOverride extends Context.Service<SlotCacheOverride, SlotCache>()(
  "client-core/SlotCacheOverride",
) {}

const CACHE_NAME = "folio-ratelimit";
// Exported so tests can seed "another isolate already used quota".
export const SLOT_URL_PREFIX = "https://ratelimit.folio.internal/slot/";
const URL_PREFIX = SLOT_URL_PREFIX;

export interface SlotCursor {
  // Pushes the cursor by spacingMs; returns the pre-push value (≥ now), i.e. the granted slot.
  readonly advance: (spacingMs: number, now: number) => Effect.Effect<number>;
}

// Module-level on purpose: on Workers, state in a `Scope` or Layer resets every request.
const cursors = new Map<string, SlotCursor>();

// No reset: tests isolate by using distinct keys (in node there is no `caches`, so it's memory-only).
export function cursorFor(key: string): SlotCursor {
  const found = cursors.get(key);
  if (found) return found;
  const created = makeCursor(key);
  cursors.set(key, created);
  return created;
}

function makeCursor(key: string): SlotCursor {
  const url = URL_PREFIX + encodeURIComponent(key);
  // Serializes the whole grab, not just the tat update (see top of file).
  const lock = Semaphore.makeUnsafe(1);
  let tat = Number.NEGATIVE_INFINITY;
  let seeded = false;
  // "unknown": write not probed yet; "dead": not on Workers, or writes don't stick.
  let health: "unknown" | "ok" | "dead" = "unknown";
  let opening: Promise<SlotCache | undefined> | undefined;

  const open = (): Effect.Effect<SlotCache | undefined> =>
    Effect.gen(function* () {
      const override = yield* Effect.serviceOption(SlotCacheOverride);
      if (Option.isSome(override)) return override.value;
      if (health === "dead") return undefined;
      const caches = (globalThis as { caches?: { open(n: string): Promise<SlotCache> } }).caches;
      if (!caches) {
        health = "dead"; // not on Workers (node tests); not a misconfiguration, stay quiet
        return undefined;
      }
      opening ??= caches.open(CACHE_NAME);
      return yield* Effect.promise(() => opening as Promise<SlotCache>);
    });

  // Read shared progress once per key; afterwards the local cursor only moves forward. A failed
  // read counts as a miss — the limiter must not become a failure source.
  const seed = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (seeded) return;
      seeded = true;
      const cache = yield* open();
      if (!cache) return;
      const hit = yield* Effect.tryPromise(() => cache.match(url)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!hit) return;
      const text = yield* Effect.tryPromise(() => hit.text()).pipe(Effect.orElseSucceed(() => ""));
      const shared = Number(text);
      if (Number.isFinite(shared) && shared > tat) tat = shared; // only ever raise
    });

  // On `*.workers.dev` cache put/match are silent no-ops, so probe once after the first write and
  // warn if it didn't stick; otherwise the gate looks alive while doing nothing.
  const publish = (slotAt: number, spacingMs: number, now: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const cache = yield* open();
      if (!cache) return;
      // Keep until the cursor expires; at least 1s (max-age=0 means uncacheable).
      const ttlSec = Math.max(1, Math.ceil((slotAt - now + spacingMs) / 1000));
      const wrote = yield* Effect.tryPromise(() =>
        cache.put(
          url,
          new Response(String(slotAt), { headers: { "cache-control": `max-age=${ttlSec}` } }),
        ),
      ).pipe(
        Effect.as(true),
        // A failed write degrades to per-isolate limiting.
        Effect.orElseSucceed(() => false),
      );
      if (!wrote || health !== "unknown") return;
      const hit = yield* Effect.tryPromise(() => cache.match(url)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      health = hit ? "ok" : "dead";
      if (health === "dead") {
        console.warn(
          "ratelimit: Cache API writes are not sticking — throttling is per-isolate only. " +
            "On *.workers.dev every cache put/match is a silent no-op; bind a custom domain.",
        );
      }
    });

  return {
    advance: (spacingMs, now) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* seed(); // async on first call — the reason the whole block is locked
          const mine = Math.max(tat, now);
          tat = mine + spacingMs;
          yield* publish(mine + spacingMs, spacingMs, now);
          return mine;
        }),
      ),
  };
}
