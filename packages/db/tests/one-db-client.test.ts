import { env } from "cloudflare:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { provideDbClient } from "../src/client";
import type { DbEnv } from "../src/connect";
import { provideCurrentUser } from "../src/current-user";
import { Database, DatabaseForOracle, GlobalDatabase } from "../src/database";

// One drizzle handle per request (a hard rule). Tickets are built once per isolate and hold no connection; the assembly point calls `provideDbClient(env)` once per request and each op reads it from context.
//
// So the mechanism is simply one value in context that every reader sees; these pin that, plus its negative control.
//
// Counting: `drizzle(env.DB)` reads `env.DB` once, so an env whose `DB` is a getter counts real constructions, not reference comparisons.
const counting = (): { env: DbEnv; built: () => number } => {
  let n = 0;
  return {
    env: {
      get DB() {
        n += 1;
        return env.DB;
      },
    },
    built: () => n,
  };
};

// Production-shaped: three tickets built once (an isolate-level `ManagedRuntime` in production); each request supplies only two values.
const tickets = Layer.mergeAll(
  Database.layer,
  DatabaseForOracle.layer("coingecko"),
  GlobalDatabase.layer,
);

// One "request": one op in each of four domains across the three tickets.
const oneRequest = Effect.gen(function* () {
  const db = yield* Database;
  const forOracle = yield* DatabaseForOracle;
  const global = yield* GlobalDatabase;
  yield* db.accounts.list();
  yield* db.settings.get();
  yield* forOracle.cache.get("probe");
  yield* global.accounts.listUserIds();
});

describe("one DbClient per request", () => {
  it("all ops in one request across tickets and domains build a single handle", async () => {
    const c = counting();
    const runtime = ManagedRuntime.make(tickets);
    await runtime.runPromise(
      oneRequest.pipe(provideCurrentUser("user-probe"), provideDbClient(c.env)),
    );
    expect(c.built()).toBe(1);
    await runtime.dispose();
  });

  // Negative control: proves the counter counts real constructions (the 1 above isn't a counter that never counts), and that a handle is built once per run (`Effect.sync`). Tickets are shared across requests; a fresh root fiber is another run (the `/api/sync` background job).
  it("running the same combinator twice gives two handles; the tickets stay the same", async () => {
    const c = counting();
    const runtime = ManagedRuntime.make(tickets);
    const request = oneRequest.pipe(
      Effect.andThen(Database),
      provideCurrentUser("user-probe"),
      provideDbClient(c.env),
    );
    const first = await runtime.runPromise(request);
    const second = await runtime.runPromise(request);
    expect(c.built()).toBe(2);
    expect(first).toBe(second);
    await runtime.dispose();
  });
});
