import { type Outbound, SigningFailure } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import type { UpstreamError } from "@folio/upstream-basic";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  make,
  parseChainIds,
  RabbyClient,
  type RabbyClientApi,
  type RabbyConfig,
} from "../src/client";
import { CHAINS_CACHE_TTL_MS, RABBY_API_BASE } from "../src/constants";
import { RabbySigner, type SignRequest } from "../src/signer";
import tokensFixture from "./fixtures/cache-token-list.json" with { type: "json" };
import chainListFixture from "./fixtures/chain-list.json" with { type: "json" };
import protocolsFixture from "./fixtures/complex-protocol-list.json" with { type: "json" };

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// Fake egress that records every request. Replaces the `HttpClient` service, not `globalThis.fetch`, so the real path is exercised.
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// Fake signer that records what it was asked to sign. The real one needs wasm (runs only in Workers); what is verified here is the wiring:
// is the params passed in the copy actually sent, are all headers present. The signature algorithm is not under test.
function fakeSigner() {
  const signed: Array<{ method: string; path: string; params: Record<string, unknown> }> = [];
  const sign: SignRequest = (method, path, params) => {
    signed.push({ method, path, params });
    return Effect.succeed({
      "X-Api-Ts": "1700000000",
      "X-Api-Nonce": "n0nce",
      "X-Api-Ver": "0.93.49",
      "X-Api-Sign": `sig(${method} ${path} ${JSON.stringify(params)})`,
      "X-Client": "Rabby",
      "X-Version": "0.93.49",
    });
  };
  return { sign, signed };
}

// The cache is bucketed by baseUrl, so each case gets its own base and is isolated with no reset.
let bases = 0;
const freshBase = () => `https://rabby-${bases++}.test`;

const withClient = <A, E>(
  fn: HttpStub,
  use: (client: RabbyClientApi) => Effect.Effect<A, E, Outbound>,
  over: Partial<RabbyConfig> = {},
  sign: SignRequest = fakeSigner().sign,
): Promise<A> =>
  runClient(
    fn,
    Effect.gen(function* () {
      const client = yield* make({ apiBase: freshBase(), ...over });
      return yield* use(client);
    }).pipe(Effect.provideService(RabbySigner, sign)),
  );

const failing = (
  fn: HttpStub,
  use: (c: RabbyClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

const byPath = () =>
  stub((url) =>
    url.pathname.includes("chain/list")
      ? json(chainListFixture)
      : url.pathname.includes("complex_protocol")
        ? json(protocolsFixture)
        : json(tokensFixture),
  );

describe("signing", () => {
  it("the signed params are the query actually sent (upstream hashes it sorted by key; one difference wastes the signature)", async () => {
    const { fn, calls } = byPath();
    const signer = fakeSigner();
    await withClient(fn, (c) => c.tokens(ADDR), {}, signer.sign);

    expect(signer.signed[0].method).toBe("GET");
    expect(signer.signed[0].path).toBe("/v1/user/cache_token_list");
    expect(signer.signed[0].params).toEqual({ id: ADDR });
    // The query sent matches the one signed.
    expect(calls[0].request.url.searchParams.get("id")).toBe(ADDR);
    expect([...calls[0].request.url.searchParams.keys()]).toEqual(["id"]);
  });

  it("all six signature headers are sent (without one it falls back to the one-request-per-40s tier)", async () => {
    const { fn, calls } = byPath();
    await withClient(fn, (c) => c.tokens(ADDR));
    const h = calls[0].request.headers;
    for (const key of [
      "X-Api-Ts",
      "X-Api-Nonce",
      "X-Api-Ver",
      "X-Api-Sign",
      "X-Client",
      "X-Version",
    ]) {
      expect(h[key]).toBeTruthy();
    }
    expect(h.accept).toBe("application/json");
  });

  it("an endpoint without a query signs empty params", async () => {
    const { fn } = byPath();
    const signer = fakeSigner();
    await withClient(fn, (c) => c.chainIds, {}, signer.sign);
    expect(signer.signed[0].path).toBe("/v1/chain/list");
    expect(signer.signed[0].params).toEqual({});
  });

  it("signing fails: a credentials problem, not a transport fault (retrying is a wasted round trip; usually upstream changed the signing protocol)", async () => {
    const { fn } = byPath();
    const boom: SignRequest = (_m, path) => Effect.fail(new SigningFailure({ where: path }));
    const err = await withClient(fn, (c) => Effect.flip(c.tokens(ADDR)), {}, boom);
    expect(err._tag).toBe("UpstreamAuthError");
  });
});

describe("endpoints", () => {
  it("tokens: all chains in one response, the address goes in id", async () => {
    const { fn, calls } = byPath();
    const rows = await withClient(fn, (c) => c.tokens(ADDR), { apiBase: RABBY_API_BASE });
    expect(calls[0].request.url.origin).toBe(RABBY_API_BASE);
    expect(calls[0].request.url.pathname).toBe("/v1/user/cache_token_list");
    // Values are not translated, but only declared fields come out (schema default): the DTO is "the fields we read"; `asset` / `cex_ids`
    // and the like in the fixture were never read, so they do not come out either.
    expect(rows).toHaveLength(tokensFixture.length);
    expect(rows[0].symbol).toBe(tokensFixture[0].symbol);
    expect(rows[0].amount).toBe(tokensFixture[0].amount);
    expect("cex_ids" in rows[0]).toBe(false);
  });

  it("protocols: likewise all chains in one response", async () => {
    const { fn, calls } = byPath();
    const rows = await withClient(fn, (c) => c.protocols(ADDR));
    expect(calls[0].request.url.pathname).toBe("/v1/user/complex_protocol_list");
    expect(rows).toHaveLength(protocolsFixture.length);
    expect(rows[0].id).toBe(protocolsFixture[0].id);
    expect(rows[0].portfolio_item_list).toHaveLength(
      protocolsFixture[0].portfolio_item_list.length,
    );
    expect("has_supported_portfolio" in rows[0]).toBe(false);
  });

  it("totalBalance: the lightest endpoint, for liveness probes", async () => {
    const { fn, calls } = stub(() => json({ total_usd_value: 1 }));
    await withClient(fn, (c) => c.totalBalance(ADDR));
    expect(calls[0].request.url.pathname).toBe("/v1/user/total_balance");
  });

  it("apiBase can be overridden and is used as one opaque string", async () => {
    const { fn, calls } = byPath();
    await withClient(fn, (c) => c.tokens(ADDR), { apiBase: "http://localhost:3099/rabby-proxy" });
    expect(calls[0].request.url.href).toContain("/rabby-proxy/v1/user/cache_token_list");
  });
});

describe("chainIds", () => {
  it("community_id is the canonical chainId", () => {
    const map = parseChainIds([
      { id: "eth", community_id: 1 },
      { id: "bsc", community_id: 56 },
      { id: "arb", community_id: 42161 },
      { id: "broken" }, // no community_id: skipped, no fallback form
    ]);
    expect(map).toEqual({ eth: 1, bsc: 56, arb: 42161 });
  });

  it("cached: asking twice fetches once", async () => {
    const { fn, calls } = byPath();
    await withClient(fn, (c) => Effect.all([c.chainIds, c.chainIds]));
    expect(calls).toHaveLength(1);
  });

  it("concurrent asks also fetch once", async () => {
    const { fn, calls } = byPath();
    await withClient(fn, (c) =>
      Effect.all([c.chainIds, c.chainIds, c.chainIds], { concurrency: "unbounded" }),
    );
    expect(calls).toHaveLength(1);
  });

  it("refresh fails but an old mapping exists: uses the old one", async () => {
    const base = freshBase();
    let dead = false;
    const { fn } = stub(() => (dead ? json({}, { status: 503 }) : json(chainListFixture)));
    const map = await runClient(
      fn,
      Effect.gen(function* () {
        const client = yield* make({ apiBase: base });
        yield* client.chainIds;
        dead = true;
        yield* TestClock.adjust(Duration.millis(CHAINS_CACHE_TTL_MS + 1));
        return yield* client.chainIds;
      }).pipe(Effect.provideService(RabbySigner, fakeSigner().sign)),
    );
    expect(Object.keys(map).length).toBeGreaterThan(0);
  });

  it("no mapping at all: hard failure, never degrading to the slug fallback form", async () => {
    const { fn } = stub(() => json([]));
    const err = await failing(fn, (c) => c.chainIds);
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe("rabby");
  });
});

describe("rate limiting: limit=1, no bursts", () => {
  // Rabby throttles instantaneous concurrency, not total volume, and its 429 carries no Retry-After: the policy is "never hit it".
  // The `memory` tier is the official token bucket: limit 1 / 125ms makes the 2nd request wait 125ms.
  const settledAfter = (
    ms: number,
    use: (c: RabbyClientApi) => Effect.Effect<unknown, never, Outbound>,
  ) =>
    runClient(
      byPath().fn,
      Effect.gen(function* () {
        const client = yield* make({ apiBase: freshBase() });
        const fiber = yield* Effect.forkChild(use(client));
        yield* TestClock.adjust(Duration.millis(ms));
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        return (yield* Effect.sync(() => fiber.pollUnsafe())) !== undefined;
      }).pipe(Effect.provideService(RabbySigner, fakeSigner().sign)),
    );

  it("the second request waits (no bursts)", async () => {
    const two = (c: RabbyClientApi) =>
      Effect.all([Effect.orDie(c.tokens(ADDR)), Effect.orDie(c.tokens(ADDR))]);
    expect(await settledAfter(124, two)).toBe(false);
    expect(await settledAfter(125, two)).toBe(true);
  });
});

describe("error classification", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ err: 1 }, init));
    return failing(fn, (c) => c.tokens(ADDR));
  };

  it("429 gives rate-limited (rabby gives no Retry-After, so retryAfterMs is undefined)", async () => {
    const err = await failWith({ status: 429 });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBeUndefined();
  });

  it("5xx / unreachable give unreachable", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("unreadable JSON gives parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.tokens(ADDR)))._tag).toBe("UpstreamParseError");
  });

  it("the failure info carries no query / address", async () => {
    const err = await failWith({ status: 503 });
    expect(err.where).toBe("/v1/user/cache_token_list");
    expect(JSON.stringify(err)).not.toContain(ADDR);
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `RabbyClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json({ total_usd_value: 1 }));
    const out = await runClient(
      fn,
      Effect.flatMap(RabbyClient, (client) => client.totalBalance(ADDR)).pipe(
        Effect.provide(RabbyClient.layer({ apiBase: freshBase() })),
        // The signer is still fake: the real one is wasm and runs only in Workers.
        Effect.provideService(RabbySigner, fakeSigner().sign),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
