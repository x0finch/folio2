import type { Outbound } from "@folio/client-core";
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
import { make, ZerionClient, type ZerionClientApi, type ZerionConfig } from "../src/client";
import { CHAINS_CACHE_TTL_MS, ZERION_API_BASE } from "../src/constants";
import chainsFixture from "./fixtures/chains.json" with { type: "json" };
import positionsFixture from "./fixtures/positions.json" with { type: "json" };

const KEY = "the-api-key";
const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// Fake egress that records every request. Replaces the `HttpClient` service, not `globalThis.fetch`, so the real path is exercised.
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// The chain mapping cache is bucketed by baseUrl (see chains-cache.ts), so each case gets its own base and is isolated with no global
// reset switch. The default base is for cases that do not touch the cache.
let bases = 0;
const freshBase = () => `https://zerion-${bases++}.test`;

const withClient = <A, E>(
  fn: HttpStub,
  use: (client: ZerionClientApi) => Effect.Effect<A, E, Outbound>,
  over: Partial<ZerionConfig> = {},
): Promise<A> =>
  // `runClient` wires fake egress + `memory` rate-limit tier + TestClock, shared by all client packages.
  runClient(
    fn,
    Effect.gen(function* () {
      const client = yield* make({ apiBase: freshBase(), ...over });
      return yield* use(client);
    }),
  );

const failing = (
  fn: HttpStub,
  use: (c: ZerionClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

// chains and positions are routed by path.
const bothEndpoints = (opts: { chains?: () => Response; positions?: () => Response } = {}) =>
  stub((url) =>
    url.pathname.includes("/chains")
      ? (opts.chains?.() ?? json(chainsFixture))
      : (opts.positions?.() ?? json(positionsFixture)),
  );

describe("auth", () => {
  it("HTTP Basic: key as username, empty password, in the header not the query", async () => {
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) => c.positions({ address: ADDR, apiKey: KEY }));
    const auth = calls[0].request.headers.authorization;
    expect(auth).toBe(`Basic ${btoa(`${KEY}:`)}`);
    // Decode to confirm the password slot is empty: `key:key` would also work upstream but exposes the key twice.
    expect(atob(auth.slice("Basic ".length))).toBe(`${KEY}:`);
    expect(calls[0].request.url.searchParams.has("apiKey")).toBe(false);
  });
});

describe("positions", () => {
  it("hits the right path with the three filters (without no_filter no DeFi row comes back)", async () => {
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) => c.positions({ address: ADDR, apiKey: KEY }), {
      apiBase: ZERION_API_BASE,
    });
    expect(calls[0].request.url.origin).toBe(ZERION_API_BASE);
    expect(calls[0].request.url.pathname).toBe(`/v1/wallets/${ADDR}/positions/`);
    // The default is only_simple, which drops all protocol positions; this query is what makes DeFi rows exist.
    expect(calls[0].request.url.searchParams.get("filter[positions]")).toBe("no_filter");
    expect(calls[0].request.url.searchParams.get("filter[trash]")).toBe("only_non_trash");
    expect(calls[0].request.url.searchParams.get("currency")).toBe("usd");
  });

  it("values are not translated, but only declared fields come out", async () => {
    const { fn } = bothEndpoints();
    const res = await withClient(fn, (c) => c.positions({ address: ADDR, apiKey: KEY }));

    expect(res.data).toHaveLength(positionsFixture.data.length);
    // Declared fields are untouched.
    const first = res.data?.[0].attributes;
    const fixture = positionsFixture.data[0].attributes;
    expect(first?.quantity?.float).toBe(fixture.quantity.float);
    expect(first?.fungible_info?.symbol).toBe(fixture.fungible_info.symbol);
    // Undeclared ones are dropped (schema default): the DTO is "the fields we read".
    expect("id" in positionsFixture.data[0]).toBe(true);
    expect("id" in res.data![0]).toBe(false);
  });
});

describe("chainIds", () => {
  it("hex external_id becomes a decimal number", async () => {
    const { fn } = bothEndpoints();
    const map = await withClient(fn, (c) => c.chainIds(KEY));
    expect(map.ethereum).toBe(1);
    expect(map.base).toBe(8453); // 0x2105
  });

  it("cached: the same client asked twice fetches once", async () => {
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) => Effect.all([c.chainIds(KEY), c.chainIds(KEY)]));
    expect(calls).toHaveLength(1);
  });

  it("the cache is shared across client instances (on CF Workers each request has its own Layer; binding to a Scope would mean no cache)", async () => {
    const base = freshBase();
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) => c.chainIds(KEY), { apiBase: base });
    await withClient(fn, (c) => c.chainIds(KEY), { apiBase: base });
    expect(calls).toHaveLength(1);
  });

  it("concurrent asks also fetch once (the old version had no lock: 6 accounts cold-starting fetched 6 times)", async () => {
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) =>
      Effect.all([c.chainIds(KEY), c.chainIds(KEY), c.chainIds(KEY), c.chainIds(KEY)], {
        concurrency: "unbounded",
      }),
    );
    expect(calls).toHaveLength(1);
  });

  it("refetches after the TTL", async () => {
    const base = freshBase();
    const { fn, calls } = bothEndpoints();
    await runClient(
      fn,
      Effect.gen(function* () {
        const client = yield* make({ apiBase: base });
        yield* client.chainIds(KEY);
        yield* TestClock.adjust(Duration.millis(CHAINS_CACHE_TTL_MS + 1));
        yield* client.chainIds(KEY);
      }),
    );
    expect(calls).toHaveLength(2);
  });

  it("refresh fails but an old mapping exists: uses the old one (chainId is immutable, so still correct)", async () => {
    const base = freshBase();
    let dead = false;
    const { fn } = stub(() => (dead ? json({}, { status: 503 }) : json(chainsFixture)));

    const map = await runClient(
      fn,
      Effect.gen(function* () {
        const client = yield* make({ apiBase: base });
        yield* client.chainIds(KEY);
        dead = true;
        yield* TestClock.adjust(Duration.millis(CHAINS_CACHE_TTL_MS + 1));
        return yield* client.chainIds(KEY);
      }),
    );
    expect(map.ethereum).toBe(1);
  });

  it("no mapping at all: hard failure, never degrading to the slug fallback form", async () => {
    // The fallback form would split identity from the canonical one and pollute the token index; failing means nothing is produced and the round retries.
    const { fn } = stub(() => json({}, { status: 503 }));
    expect((await failing(fn, (c) => c.chainIds(KEY)))._tag).toBe("UpstreamUnavailableError");
  });

  it("an empty response counts as not fetched (200 but no chain at all)", async () => {
    const { fn } = stub(() => json({ data: [] }));
    const err = await failing(fn, (c) => c.chainIds(KEY));
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe("zerion");
  });
});

describe("portfolio", () => {
  it("hits the light endpoint (liveness probe, far smaller than positions)", async () => {
    const { fn, calls } = stub(() => json({ data: {} }));
    await withClient(fn, (c) => c.portfolio({ address: ADDR, apiKey: KEY }));
    expect(calls[0].request.url.pathname).toBe(`/v1/wallets/${ADDR}/portfolio`);
  });
});

describe("error classification", () => {
  // Zerion has no classification difference; these check that core's default rules do work on this path.
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ errors: [{ title: "nope" }] }, init));
    return failing(fn, (c) => c.positions({ address: ADDR, apiKey: KEY }));
  };

  it("401 / 403 give a credentials problem (wrong key)", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 gives rate-limited, with Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "5" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(5000);
  });

  it("5xx gives unreachable", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("unreadable JSON gives parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.positions({ address: ADDR, apiKey: KEY })))._tag).toBe(
      "UpstreamParseError",
    );
  });

  it("the failure info carries no query / key", async () => {
    const err = await failWith({ status: 503 });
    // The address is in the pathname (Zerion's path shape), but the key and query must never appear.
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("filter[trash]");
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `ZerionClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json(chainsFixture));
    const out = await runClient(
      fn,
      Effect.flatMap(ZerionClient, (client) => client.chainIds(KEY)).pipe(
        Effect.provide(ZerionClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
