import type { TokenRef } from "@folio/oracle-basic";
import type { UpstreamError } from "@folio/upstream-basic";
import { FxUpstream, PlatformUpstream, TokenUpstream } from "@folio/upstream-basic/ports";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  COINGECKO_API_KEY,
  COINGECKO_PRO_API_KEY,
  HEADER_DEMO,
  HEADER_PRO,
} from "../../src/market/coingecko/constants";
import { fxUpstreamOn } from "../../src/market/coingecko/fx";
import { platformUpstreamOn } from "../../src/market/coingecko/platform";
import { tokenUpstreamOn } from "../../src/market/coingecko/token";
import { connection } from "../../src/market/coingecko/upstream";
import {
  type HttpClientRequestLike,
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../src/runtime/testing";
import assetPlatforms from "../market/coingecko/fixtures/asset-platforms.json";
import simplePrice from "../market/coingecko/fixtures/simple-price.json";
import { expectNoSecret, RETRY_AFTER_SECONDS, recorder, replies, safeJson } from "./contract";

type Env = Readonly<Record<string, string>>;
type Reply = (request: HttpClientRequestLike) => Response | Promise<Response>;

const REFS = ["coingecko/issued:bitcoin", "coingecko/issued:ethereum"] as TokenRef[];
// No recording of `/exchange_rates`; quoted against BTC like the real one.
const EXCHANGE_RATES = {
  rates: {
    btc: { value: 1, type: "crypto" },
    usd: { value: 100000, type: "fiat" },
    eur: { value: 92000, type: "fiat" },
  },
};

const happy: Reply = ({ url }) => {
  if (url.pathname.endsWith("/simple/price")) return json(simplePrice.response);
  if (url.pathname.endsWith("/exchange_rates")) return json(EXCHANGE_RATES);
  if (url.pathname.endsWith("/asset_platforms")) return json(assetPlatforms);
  throw new Error(`unstubbed endpoint: ${url.pathname}`);
};

// The ports as the app builds them, over a fake `HttpClient` instead of the real one.
const ports = (stub: HttpStub, env: Env) => {
  const transport = Layer.merge(connection(env), stub.layer);
  return Layer.mergeAll(
    tokenUpstreamOn(transport),
    fxUpstreamOn(transport),
    platformUpstreamOn(transport),
  );
};

type Port = TokenUpstream | FxUpstream | PlatformUpstream;

const capabilities: Record<string, Effect.Effect<(number | string)[], UpstreamError, Port>> = {
  fetchPrices: Effect.flatMap(TokenUpstream, (port) =>
    Effect.map(port.fetchPrices(REFS), (prices) => [...prices.values()].map((p) => p.unitPrice)),
  ),
  fetchRates: Effect.flatMap(FxUpstream, (port) =>
    Effect.map(port.fetchRates(), (rates) => [...rates.values()]),
  ),
  fetchChains: Effect.flatMap(PlatformUpstream, (port) =>
    Effect.map(port.fetchChains(), (chains) => chains.map((c) => c.key)),
  ),
};

// Each request retries once after a backoff, and `TestClock` only moves when told to.
const drive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let i = 0; i < 10; i++) {
      yield* Effect.repeat(Effect.yieldNow, { times: 20 });
      yield* TestClock.adjust(Duration.seconds(1));
    }
    return yield* Fiber.join(fiber);
  });

const run = <A, E>(stub: HttpStub, effect: Effect.Effect<A, E, Port>, env: Env = {}) =>
  runClient(stub, drive(Effect.provide(effect, ports(stub, env))), "none");
const failure = (reply: Reply, effect: Effect.Effect<unknown, UpstreamError, Port>) =>
  run(httpStub(reply), Effect.flip(effect));

describe.each(Object.entries(capabilities))("coingecko %s: market contract", (_, capability) => {
  it("happy path: non-empty output of positive numbers or keys", async () => {
    const out = await run(httpStub(happy), capability);
    expect(out.length).toBeGreaterThan(0);
    for (const value of out) {
      if (typeof value === "number") expect(value).toBeGreaterThan(0);
      else expect(value).toMatch(/\S/);
    }
  });

  it.each([401, 403])("%i gives auth, without a retry", async (status) => {
    const stub = httpStub(replies.status(status));
    expect((await run(stub, Effect.flip(capability)))._tag).toBe("UpstreamAuthError");
    expect(stub.calls).toHaveLength(1);
  });

  it("429 gives rate-limited, carrying Retry-After", async () => {
    const error = await failure(replies.rateLimited, capability);
    expect(error._tag).toBe("UpstreamRateLimitError");
    expect(error._tag === "UpstreamRateLimitError" && error.retryAfterMs).toBe(
      RETRY_AFTER_SECONDS * 1000,
    );
  });

  it("503 and a network failure give unavailable", async () => {
    expect((await failure(replies.status(503), capability))._tag).toBe("UpstreamUnavailableError");
    expect((await failure(replies.offline, capability))._tag).toBe("UpstreamUnavailableError");
  });

  it("a 200 with an unreadable body gives parse", async () => {
    expect((await failure(replies.garbage, capability))._tag).toBe("UpstreamParseError");
  });

  it("keyless works and sends no key header; a configured key is sent", async () => {
    const keyless = httpStub(happy);
    await run(keyless, capability);
    const headers = keyless.calls[0].request.headers;
    expect(headers[HEADER_DEMO]).toBeUndefined();
    expect(headers[HEADER_PRO]).toBeUndefined();

    const keyed = httpStub(happy);
    await run(keyed, capability, { [COINGECKO_API_KEY]: "demo-key" });
    expect(keyed.calls[0].request.headers[HEADER_DEMO]).toBe("demo-key");
  });

  it.each([
    COINGECKO_API_KEY,
    COINGECKO_PRO_API_KEY,
  ])("no %s value reaches a span, a log line or an error", async (key) => {
    const secret = `s3cr3t-${key}`;
    const env = { [key]: secret };
    const capture = recorder();
    const recorded = <A, E>(effect: Effect.Effect<A, E, Port>) =>
      Effect.provide(effect, capture.layer);
    await run(httpStub(happy), recorded(capability), env);
    const errors = await Promise.all(
      [replies.status(401), replies.status(503), replies.offline, replies.garbage].map((reply) =>
        run(httpStub(reply), recorded(Effect.flip(capability)), env),
      ),
    );

    expect(capture.spanNames()).toContain("http.client.request");
    expectNoSecret([...capture.recorded(), ...errors.map((e) => safeJson(e))], [secret]);
  });
});
