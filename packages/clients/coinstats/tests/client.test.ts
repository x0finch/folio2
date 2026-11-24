import type { UpstreamError } from "@folio/upstream-basic";
import type { Outbound } from "@folio/upstreams";
import { type HttpStub, httpStub, jsonResponse as json, runClient } from "@folio/upstreams/testing";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  CoinstatsClient,
  type CoinstatsClientApi,
  type CoinstatsConfig,
  make,
} from "../src/client";
import { API_KEY_HEADER, COINSTATS_API_BASE } from "../src/constants";
import solanaFixture from "./fixtures/solana.json" with { type: "json" };
import suiFixture from "./fixtures/sui.json" with { type: "json" };

const KEY = "the-api-key";
const ADDR = "6dNVtBJdHRWQvvGqpuTLKZ4Q1234567890abcdefghij";

// Fake egress that records every request. Replaces the `HttpClient` service, not `globalThis.fetch`, so the real path is exercised.
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// Construction needs a Scope (the gate): built inside a scope, used, then dropped.
// The gate always uses the `memory` tier, Effect's official implementation with the bucket bound to the scope and one per make, so cases are isolated.
// Production uses `isolated`, whose algorithm behaviour is tested in `@folio/upstreams`.
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: CoinstatsClientApi) => Effect.Effect<A, E, Outbound>,
  over: Partial<CoinstatsConfig> = {},
): Promise<A> =>
  // `runClient` wires fake egress + `memory` rate-limit tier + TestClock, shared by all client packages.
  runClient(
    fn,
    Effect.gen(function* () {
      const client = yield* make({ ...over });
      return yield* use(client);
    }),
  );

const failing = (
  fn: HttpStub,
  use: (c: CoinstatsClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

describe("balance", () => {
  it("address and connectionId go in the query, apiKey in the header", async () => {
    const { fn, calls } = stub(() => json(solanaFixture));
    await withClient(fn, (c) => c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }));

    expect(calls[0].request.url.origin).toBe(COINSTATS_API_BASE);
    expect(calls[0].request.url.pathname).toBe("/wallet/balance");
    expect(calls[0].request.url.searchParams.get("address")).toBe(ADDR);
    expect(calls[0].request.url.searchParams.get("connectionId")).toBe("solana");
    // The key is a credential: header, not query (a query goes into URLs and logs).
    expect(calls[0].request.headers[API_KEY_HEADER]).toBe(KEY);
    expect(calls[0].request.url.searchParams.has("apiKey")).toBe(false);
  });

  it("values are not translated, but only declared fields come out", async () => {
    const { fn } = stub(() => json(solanaFixture));
    const coins = await withClient(fn, (c) =>
      c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }),
    );
    // Upstream returns the array directly (not { data: [...] }); parsing belongs to the adapter.
    expect(Array.isArray(coins)).toBe(true);
    expect(coins).toHaveLength(solanaFixture.length);
    // Declared fields are untouched; ones not declared in the fixture (imgUrl / coinId) do not come out (schema default, and wanted: the DTO is "the fields we read").
    expect(coins[0].symbol).toBe(solanaFixture[0].symbol);
    expect(coins[0].amount).toBe(solanaFixture[0].amount);
  });

  it("connectionId and apiKey are both per call: one client serves many chains and accounts", async () => {
    const { fn, calls } = stub((url) =>
      json(url.searchParams.get("connectionId") === "sui-wallet" ? suiFixture : solanaFixture),
    );
    await withClient(fn, (c) =>
      Effect.all([
        c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }),
        c.balance({ connectionId: "sui-wallet", address: "0xabc", apiKey: "other-key" }),
      ]),
    );
    expect(calls[0].request.url.searchParams.get("connectionId")).toBe("solana");
    expect(calls[1].request.url.searchParams.get("connectionId")).toBe("sui-wallet");
    expect(calls[1].request.headers[API_KEY_HEADER]).toBe("other-key");
  });

  it("apiBase can be overridden and is used as one opaque string", async () => {
    const { fn, calls } = stub(() => json(solanaFixture));
    await withClient(fn, (c) => c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }), {
      apiBase: "http://localhost:3099/cs-proxy",
    });
    expect(calls[0].request.url.href).toContain("/cs-proxy/wallet/balance");
  });
});

describe("blockchains", () => {
  it("sends only the key, no address: a real check that the key is still valid", async () => {
    const { fn, calls } = stub(() => json([{ connectionId: "solana" }]));
    await withClient(fn, (c) => c.blockchains(KEY));
    expect(calls[0].request.url.pathname).toBe("/wallet/blockchains");
    expect(calls[0].request.url.searchParams.has("address")).toBe(false);
    expect(calls[0].request.headers[API_KEY_HEADER]).toBe(KEY);
  });
});

describe("rate limiting: both endpoints pass the gate", () => {
  // This verifies structure, not the algorithm (the gate itself is tested in `@folio/upstreams`).
  // The `memory` tier is the official token bucket: limit 2 / 1250ms refills a token every 625ms; the first 2 requests burst and the 3rd waits for a token.
  const settledAfter = (
    ms: number,
    use: (c: CoinstatsClientApi) => Effect.Effect<unknown, never, Outbound>,
  ) =>
    runClient(
      stub(() => json(solanaFixture)).fn,
      Effect.gen(function* () {
        const client = yield* make({});
        const fiber = yield* Effect.forkChild(use(client));
        yield* TestClock.adjust(Duration.millis(ms));
        // The fake egress is a `Promise.resolve`, which TestClock does not govern: yield a few microtask turns to drain it.
        // The side held by the gate waits on the virtual clock and never completes however many turns, so both sides stay accurate.
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        return (yield* Effect.sync(() => fiber.pollUnsafe())) !== undefined;
      }),
    );

  const threeBalances = (c: CoinstatsClientApi) =>
    Effect.all(
      Array.from({ length: 3 }, () =>
        Effect.orDie(c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY })),
      ),
    );

  it("the request beyond the burst waits", async () => {
    expect(await settledAfter(624, threeBalances)).toBe(false);
    expect(await settledAfter(625, threeBalances)).toBe(true);
  });

  it("blockchains also passes the same gate (it spends the same key's quota)", async () => {
    const mixed = (c: CoinstatsClientApi) =>
      Effect.all([
        Effect.orDie(c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY })),
        Effect.orDie(c.balance({ connectionId: "sui-wallet", address: ADDR, apiKey: KEY })),
        Effect.orDie(c.blockchains(KEY)),
      ]);
    expect(await settledAfter(624, mixed)).toBe(false);
    expect(await settledAfter(625, mixed)).toBe(true);
  });
});

describe("error classification", () => {
  // CoinStats has no classification difference; these check that core's default rules do work on this path.
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ message: "nope" }, init));
    return failing(fn, (c) => c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }));
  };

  it("401 / 403 give a credentials problem (wrong key)", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 gives rate-limited, with Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "3" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(3000);
  });

  it("5xx gives unreachable", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("unreadable JSON gives parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    const err = await failing(fn, (c) =>
      c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }),
    );
    expect(err._tag).toBe("UpstreamParseError");
  });

  it("the failure info carries no query / key", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("coinstats");
    expect(err.where).toBe("/wallet/balance");
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(ADDR);
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `CoinstatsClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json([]));
    const out = await runClient(
      fn,
      Effect.flatMap(CoinstatsClient, (client) => client.blockchains(KEY)).pipe(
        Effect.provide(CoinstatsClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
