import type { UpstreamError } from "@folio/upstream-basic";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  assetPlatforms,
  type CoinGeckoCall,
  coinsList,
  coinsMarkets,
  exchangeRates,
  marketChartRange,
  simplePrice,
} from "../../../src/market/coingecko/api";
import {
  CG_BASE_FREE,
  CG_BASE_PRO,
  HEADER_DEMO,
  HEADER_PRO,
  USER_AGENT,
} from "../../../src/market/coingecko/constants";
import { coingecko } from "../../../src/market/coingecko/upstream";
import type { Outbound } from "../../../src/runtime/http";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../../src/runtime/testing";

type Env = Readonly<Record<string, string>>;

const stub = (reply: (url: URL) => Response | Promise<Response>) =>
  httpStub((request) => reply(request.url));

const withCall = <A, E>(
  http: HttpStub,
  use: (call: CoinGeckoCall) => Effect.Effect<A, E, Outbound>,
  env: Env = {},
): Promise<A> => runClient(http, Effect.flatMap(coingecko.connect(env), use));

const failing = (
  http: HttpStub,
  use: (call: CoinGeckoCall) => Effect.Effect<unknown, UpstreamError, Outbound>,
  env: Env = {},
): Promise<UpstreamError> => withCall(http, (call) => Effect.flip(use(call)), env);

describe("tiers: the key decides base, headers and quota", () => {
  it("no key: free base, no key header", async () => {
    const http = stub(() => json([]));
    await withCall(http, assetPlatforms);
    expect(`${http.calls[0].request.url.origin}/api/v3`).toBe(CG_BASE_FREE);
    const h = http.calls[0].request.headers;
    expect(h[HEADER_DEMO]).toBeUndefined();
    expect(h[HEADER_PRO]).toBeUndefined();
  });

  it("demo key: free base, demo header", async () => {
    const http = stub(() => json([]));
    await withCall(http, assetPlatforms, { COINGECKO_API_KEY: "k1" });
    expect(`${http.calls[0].request.url.origin}/api/v3`).toBe(CG_BASE_FREE);
    expect(http.calls[0].request.headers[HEADER_DEMO]).toBe("k1");
  });

  it("pro key: pro base + pro header only", async () => {
    const http = stub(() => json([]));
    await withCall(http, assetPlatforms, { COINGECKO_PRO_API_KEY: "k1", COINGECKO_API_KEY: "k2" });
    expect(`${http.calls[0].request.url.origin}/api/v3`).toBe(CG_BASE_PRO);
    const h = http.calls[0].request.headers;
    expect(h[HEADER_PRO]).toBe("k1");
    expect(h[HEADER_DEMO]).toBeUndefined();
  });

  it("must send a User-Agent (CGK's WAF answers 403 without one; Workers sends none)", async () => {
    const http = stub(() => json([]));
    await withCall(http, assetPlatforms);
    expect(http.calls[0].request.headers["user-agent"]).toBe(USER_AGENT);
  });

  it("the base override wins for every tier; empty counts as unset", async () => {
    const http = stub(() => json([]));
    const base = "http://localhost:3099/cg";
    await withCall(http, assetPlatforms, { COINGECKO_API_BASE: ` ${base} ` });
    await withCall(http, assetPlatforms, { COINGECKO_API_BASE: base, COINGECKO_PRO_API_KEY: "k" });
    await withCall(http, assetPlatforms, { COINGECKO_API_BASE: "  ", COINGECKO_API_KEY: "" });
    expect(http.calls.map((c) => c.request.url.href)).toEqual([
      `${base}/asset_platforms`,
      `${base}/asset_platforms`,
      `${CG_BASE_FREE}/asset_platforms`,
    ]);
    expect(http.calls[2].request.headers[HEADER_DEMO]).toBeUndefined();
  });
});

describe("endpoints", () => {
  it("coinsList sends include_platform", async () => {
    const http = stub(() => json([{ id: "bitcoin" }]));
    const rows = await withCall(http, coinsList);
    expect(http.calls[0].request.url.pathname).toBe("/api/v3/coins/list");
    expect(http.calls[0].request.url.searchParams.get("include_platform")).toBe("true");
    expect(rows).toEqual([{ id: "bitcoin" }]);
  });

  it("coinsMarkets: array params joined by commas, undefined keys left out", async () => {
    const http = stub(() => json([]));
    await withCall(http, (call) => coinsMarkets(call, { vsCurrency: "usd", ids: ["btc", "eth"] }));
    const query = http.calls[0].request.url.searchParams;
    expect(query.get("vs_currency")).toBe("usd");
    expect(query.get("ids")).toBe("btc,eth");
    expect(query.has("order")).toBe(false);
    expect(query.has("page")).toBe(false);
  });

  it("simplePrice: a boolean flag not passed is not sent, rather than false", async () => {
    const off = stub(() => json({ bitcoin: { usd: 1 } }));
    await withCall(off, (call) => simplePrice(call, { ids: ["bitcoin"], vsCurrencies: ["usd"] }));
    expect(off.calls[0].request.url.searchParams.has("include_24hr_change")).toBe(false);

    const on = stub(() => json({ bitcoin: { usd: 1 } }));
    await withCall(on, (call) =>
      simplePrice(call, { ids: ["bitcoin"], vsCurrencies: ["usd"], include24hrChange: true }),
    );
    expect(on.calls[0].request.url.searchParams.get("include_24hr_change")).toBe("true");
  });

  it("marketChartRange: the output is the prices column", async () => {
    const http = stub(() => json({ prices: [[1, 2]], market_caps: [], total_volumes: [] }));
    const prices = await withCall(http, (call) =>
      marketChartRange(call, { id: "bitcoin", vsCurrency: "usd", fromSec: 1, toSec: 2 }),
    );
    expect(prices).toEqual([[1, 2]]);
    expect(http.calls[0].request.url.pathname).toBe("/api/v3/coins/bitcoin/market_chart/range");
  });
});

describe("shape check", () => {
  it("a list endpoint returning a non-array gives parse", async () => {
    const err = await failing(
      stub(() => json({ error: "rate limited" })),
      coinsList,
    );
    expect(err._tag).toBe("UpstreamParseError");
    expect(err.where).toBe("/api/v3/coins/list");
  });

  it("an object endpoint returning a non-object gives parse", async () => {
    expect(
      (
        await failing(
          stub(() => json("nope")),
          exchangeRates,
        )
      )._tag,
    ).toBe("UpstreamParseError");
  });

  it("market_chart/range missing prices gives parse", async () => {
    const err = await failing(
      stub(() => json({ market_caps: [] })),
      (call) => marketChartRange(call, { id: "bitcoin", vsCurrency: "usd", fromSec: 1, toSec: 2 }),
    );
    expect(err._tag).toBe("UpstreamParseError");
  });
});

describe("rate limiting", () => {
  // Burst 2: keyless 10/min refills a slot every 6s, so the 3rd request waits 6s.
  const settledAfter = (ms: number, env: Env = {}) =>
    runClient(
      stub(() => json([])),
      Effect.gen(function* () {
        const call = yield* coingecko.connect(env);
        const fiber = yield* Effect.forkChild(
          Effect.all([1, 2, 3].map(() => Effect.orDie(assetPlatforms(call)))),
        );
        yield* TestClock.adjust(Duration.millis(ms));
        // The fake egress is a `Promise`, which TestClock does not govern: drain a few microtask turns.
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        return (yield* Effect.sync(() => fiber.pollUnsafe())) !== undefined;
      }),
    );

  it("the request beyond the burst waits", async () => {
    expect(await settledAfter(5_999)).toBe(false);
    expect(await settledAfter(6_000)).toBe(true);
  });

  it("a demo key has far more quota (80/min: the 3rd waits 750ms, not 6s)", async () => {
    expect(await settledAfter(749, { COINGECKO_API_KEY: "k1" })).toBe(false);
    expect(await settledAfter(750, { COINGECKO_API_KEY: "k1" })).toBe(true);
  });

  it("a pro key more still (400/min: the 3rd waits 150ms)", async () => {
    expect(await settledAfter(149, { COINGECKO_PRO_API_KEY: "k1" })).toBe(false);
    expect(await settledAfter(150, { COINGECKO_PRO_API_KEY: "k1" })).toBe(true);
  });
});

describe("error classification", () => {
  const failWith = (init: ResponseInit) =>
    failing(
      stub(() => json({ status: { error_message: "nope" } }, init)),
      assetPlatforms,
    );

  it("the failure carries upstream and only the pathname", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("coingecko");
    expect(err.where).toBe("/api/v3/asset_platforms");
  });

  it("the key is not in the URL (it goes in a header)", async () => {
    const http = stub(() => json([]));
    await withCall(http, assetPlatforms, { COINGECKO_API_KEY: "s3cr3t-key" });
    expect(http.calls[0].request.url.href).not.toContain("s3cr3t-key");
  });
});
