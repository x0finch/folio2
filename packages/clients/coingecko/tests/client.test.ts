import type { Outbound, UpstreamError } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  CoinGeckoClient,
  type CoinGeckoClientApi,
  type CoinGeckoConfig,
  make,
} from "../src/client";
import { CG_BASE_FREE, CG_BASE_PRO, HEADER_DEMO, HEADER_PRO, USER_AGENT } from "../src/constants";

// Fake egress that records every request. Replaces the `HttpClient` service, not `globalThis.fetch`, so the real path
// (headers, method, body) is exercised.
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

const withClient = <A, E>(
  fn: HttpStub,
  use: (client: CoinGeckoClientApi) => Effect.Effect<A, E, Outbound>,
  config: CoinGeckoConfig = {},
): Promise<A> =>
  // `runClient` wires fake egress + `memory` rate-limit tier + TestClock, shared by all client packages (hand-copied versions once
  // missed the rate tier and silently ran on the module-level shared cursor).
  runClient(
    fn,
    Effect.gen(function* () {
      const client = yield* make(config);
      return yield* use(client);
    }),
  );

const failing = (
  fn: HttpStub,
  use: (c: CoinGeckoClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
  config: CoinGeckoConfig = {},
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)), config);

describe("tiers: the key decides base, headers and quota", () => {
  it("no key: free base, no key header", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms);
    expect(`${calls[0].request.url.origin}/api/v3`).toBe(CG_BASE_FREE);
    const h = calls[0].request.headers;
    expect(h[HEADER_DEMO]).toBeUndefined();
    expect(h[HEADER_PRO]).toBeUndefined();
  });

  it("with a key: demo header", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { apiKey: "k1" });
    expect(calls[0].request.headers[HEADER_DEMO]).toBe("k1");
  });

  it("pro: pro base + pro header", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { apiKey: "k1", pro: true });
    expect(`${calls[0].request.url.origin}/api/v3`).toBe(CG_BASE_PRO);
    const h = calls[0].request.headers;
    expect(h[HEADER_PRO]).toBe("k1");
    expect(h[HEADER_DEMO]).toBeUndefined();
  });

  it("must send a User-Agent (CGK's WAF answers 403 without one; Workers sends none)", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms);
    expect(calls[0].request.headers["user-agent"]).toBe(USER_AGENT);
  });

  it("baseUrl can be overridden", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { baseUrl: "http://localhost:3099/cg" });
    expect(calls[0].request.url.href).toContain("/cg/asset_platforms");
  });
});

describe("endpoints", () => {
  it("coinsList sends include_platform", async () => {
    const { fn, calls } = stub(() => json([{ id: "bitcoin" }]));
    const rows = await withClient(fn, (c) => c.coinsList);
    expect(calls[0].request.url.pathname).toBe("/api/v3/coins/list");
    expect(calls[0].request.url.searchParams.get("include_platform")).toBe("true");
    expect(rows).toEqual([{ id: "bitcoin" }]);
  });

  it("coinsMarkets: array params joined by commas, undefined keys left out", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.coinsMarkets({ vsCurrency: "usd", ids: ["btc", "eth"] }));
    expect(calls[0].request.url.searchParams.get("vs_currency")).toBe("usd");
    expect(calls[0].request.url.searchParams.get("ids")).toBe("btc,eth");
    // Params not passed must not appear in the URL.
    expect(calls[0].request.url.searchParams.has("order")).toBe(false);
    expect(calls[0].request.url.searchParams.has("page")).toBe(false);
  });

  it("simplePrice: a boolean flag not passed is not sent, rather than false", async () => {
    // Sending "false" and omitting are not the same to CGK.
    const { fn, calls } = stub(() => json({ bitcoin: { usd: 1 } }));
    await withClient(fn, (c) => c.simplePrice({ ids: ["bitcoin"], vsCurrencies: ["usd"] }));
    expect(calls[0].request.url.searchParams.has("include_24hr_change")).toBe(false);

    const { fn: on, calls: onCalls } = stub(() => json({ bitcoin: { usd: 1 } }));
    await withClient(on, (c) =>
      c.simplePrice({ ids: ["bitcoin"], vsCurrencies: ["usd"], include24hrChange: true }),
    );
    expect(onCalls[0].request.url.searchParams.get("include_24hr_change")).toBe("true");
  });

  it("coinsMarketChartRange: the output is the prices column", async () => {
    // Upstream wraps it in an object whose wrapper carries nothing.
    const { fn, calls } = stub(() =>
      json({ prices: [[1, 2]], market_caps: [], total_volumes: [] }),
    );
    const prices = await withClient(fn, (c) =>
      c.coinsMarketChartRange({ id: "bitcoin", vsCurrency: "usd", fromSec: 1, toSec: 2 }),
    );
    expect(prices).toEqual([[1, 2]]);
    expect(calls[0].request.url.pathname).toBe("/api/v3/coins/bitcoin/market_chart/range");
  });

  it("coinContract: address lowercased, not found gives null (not a failure)", async () => {
    const { fn, calls } = stub(() => json({}, { status: 404 }));
    const out = await withClient(fn, (c) => c.coinContract("ethereum", "0xAbCdEf"));
    expect(out).toBeNull();
    expect(calls[0].request.url.pathname).toBe("/api/v3/coins/ethereum/contract/0xabcdef");
  });

  it("exchange / derivativesExchange not found also give null", async () => {
    const { fn } = stub(() => json({}, { status: 404 }));
    expect(await withClient(fn, (c) => c.exchange("nope"))).toBeNull();
    expect(await withClient(fn, (c) => c.derivativesExchange("nope"))).toBeNull();
  });
});

describe("top-level shape guard", () => {
  // Without it the return type lies: downstream would iterate an error page as an array.
  // Not a full validation (no field is checked); that is the `Effect.Schema` step.
  it("a list endpoint returning a non-array gives parse", async () => {
    const { fn } = stub(() => json({ error: "rate limited" }));
    const err = await failing(fn, (c) => c.coinsList);
    expect(err._tag).toBe("UpstreamParseError");
    expect(err.where).toBe("/api/v3/coins/list");
  });

  it("an object endpoint returning a non-object gives parse", async () => {
    const { fn } = stub(() => json("nope"));
    expect((await failing(fn, (c) => c.exchangeRates))._tag).toBe("UpstreamParseError");
  });

  it("market_chart/range missing prices gives parse", async () => {
    const { fn } = stub(() => json({ market_caps: [] }));
    const err = await failing(fn, (c) =>
      c.coinsMarketChartRange({ id: "bitcoin", vsCurrency: "usd", fromSec: 1, toSec: 2 }),
    );
    expect(err._tag).toBe("UpstreamParseError");
  });
});

describe("rate limiting", () => {
  // CGK most needs the gate: one key is shared across the deployment and every call spends the same quota.
  // The official token bucket refills one token every `interval / limit`: keyless 10/min with capacity 2 gives interval 12s,
  // a token every 6s; the first 2 requests burst at full rate and the 3rd waits 6s.
  const settledAfter = (ms: number, config: CoinGeckoConfig = {}) =>
    runClient(
      stub(() => json([])).fn,
      Effect.gen(function* () {
        const client = yield* make(config);
        const fiber = yield* Effect.forkChild(
          Effect.all([
            Effect.orDie(client.assetPlatforms),
            Effect.orDie(client.assetPlatforms),
            Effect.orDie(client.assetPlatforms),
          ]),
        );
        yield* TestClock.adjust(Duration.millis(ms));
        // The fake egress is a `Promise.resolve`, which TestClock does not govern: yield a few microtask turns to drain it.
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        return (yield* Effect.sync(() => fiber.pollUnsafe())) !== undefined;
      }),
    );

  it("the request beyond the burst waits", async () => {
    expect(await settledAfter(5_999)).toBe(false);
    expect(await settledAfter(6_000)).toBe(true);
  });

  it("a keyed tier has far more quota (80/min: the 3rd waits only 750ms, not 6s)", async () => {
    expect(await settledAfter(749, { apiKey: "k1" })).toBe(false);
    expect(await settledAfter(750, { apiKey: "k1" })).toBe(true);
  });
});

describe("error classification", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ status: { error_message: "nope" } }, init));
    return failing(fn, (c) => c.assetPlatforms);
  };

  it("429 gives rate-limited, with Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "9" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(9000);
  });

  it("401 / 403 give a credentials problem", async () => {
    // The old transport classed them as UPSTREAM_ERROR; the shared classification is more accurate and retry behaviour is unchanged.
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("5xx / unreachable give unreachable", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
    const { fn } = stub(() => {
      throw new Error("dns");
    });
    expect((await failing(fn, (c) => c.assetPlatforms))._tag).toBe("UpstreamUnavailableError");
  });

  it("the failure info carries upstream and only the pathname", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("coingecko");
    expect(err.where).toBe("/api/v3/asset_platforms");
  });

  it("the key is not in the URL (it goes in a header)", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { apiKey: "s3cr3t-key" });
    expect(calls[0].request.url.href).not.toContain("s3cr3t-key");
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `CoinGeckoClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json([]));
    const out = await runClient(
      fn,
      Effect.flatMap(CoinGeckoClient, (client) => client.assetPlatforms).pipe(
        Effect.provide(CoinGeckoClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
