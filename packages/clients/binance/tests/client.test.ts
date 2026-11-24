import type { Outbound } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import type { UpstreamError } from "@folio/upstream-basic";
import { Clock, Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { BinanceClient, type BinanceClientApi, type BinanceConfig, make } from "../src/client";
import {
  BINANCE_API_BASE,
  BINANCE_DELIVERY_API_BASE,
  BINANCE_FUTURES_API_BASE,
  EARN_PAGE_SIZE,
} from "../src/constants";
import accountFixture from "./fixtures/account.json" with { type: "json" };
import coinmFixture from "./fixtures/coinm-account.json" with { type: "json" };
import fundingFixture from "./fixtures/funding-assets.json" with { type: "json" };
import futuresFixture from "./fixtures/futures-account.json" with { type: "json" };
import tickerFixture from "./fixtures/ticker-price.json" with { type: "json" };

const CREDS = { apiKey: "the-key", secret: "the-secret" } as const;

// Reference implementation: does not call the code under test's `hmacSha256` but goes through WebCrypto independently in the test.
// What is verified is which string the client signed and where `signature` sits; the HMAC algorithm is WebCrypto's guarantee. Not `node:crypto`,
// so the client package needs no `@types/node` (only `db` and `apps/web` install it).
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fake egress that records every request and replies with a different body per pathname.
// Replaces the `HttpClient` service, not `globalThis.fetch`, so the real path (signature headers, method, abort) is exercised.
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// Constructing the client is itself an Effect (the gate needs a Scope), so each case builds it in a scope, uses it and drops it.
// The gate always uses the `memory` tier, Effect's official implementation with the bucket bound to the scope and one per make, so cases are isolated.
// Production uses `isolated` (cross-isolate cursor), whose algorithm behaviour is tested in `@folio/client-core`; here only the structure
// (which endpoints pass the gate and which deliberately do not).
// Under TestClock `Clock.currentTimeMillis` starts at 0, so the signing string is deterministic and can be checked against the reference.
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: BinanceClientApi) => Effect.Effect<A, E, Outbound>,
  over: Partial<BinanceConfig> = {},
): Promise<A> =>
  // `runClient` wires fake egress + `memory` rate-limit tier + TestClock, shared by all client packages.
  runClient(
    fn,
    Effect.gen(function* () {
      const client = yield* make({ ...over });
      return yield* use(client);
    }),
  );

// Failure case: same, but flipped into the success channel.
const failing = (
  fn: HttpStub,
  use: (client: BinanceClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

describe("signing", () => {
  it("signs the query except signature, joined in send order, with signature appended last", async () => {
    const { fn, calls } = stub(() => json(accountFixture));
    await withClient(fn, (c) => c.spotAccount(CREDS));

    const sent = calls[0].request.url.searchParams;
    const signature = sent.get("signature");
    expect(signature).toBeTruthy();

    // Strip signature and re-join in the original order: this is the signed string.
    const parts: string[] = [];
    sent.forEach((v, k) => {
      if (k !== "signature") parts.push(`${k}=${encodeURIComponent(v)}`);
    });
    const signable = parts.join("&");

    expect(signature).toBe(await hmacHex(CREDS.secret, signable));

    // signature must be the last param (binance verifies in send order).
    expect([...sent.keys()].at(-1)).toBe("signature");
    // Under TestClock the timestamp is deterministic, so this string is it.
    expect(signable).toBe("recvWindow=5000&timestamp=0");
  });

  it("apiKey goes in a header, not the query (it is an identifier, not signing material)", async () => {
    const { fn, calls } = stub(() => json(accountFixture));
    await withClient(fn, (c) => c.spotAccount(CREDS));
    expect(calls[0].request.headers["x-mbx-apikey"]).toBe(CREDS.apiKey);
    expect(calls[0].request.url.searchParams.has("apiKey")).toBe(false);
    expect(calls[0].request.url.searchParams.has("secret")).toBe(false);
  });
});

describe("endpoints hit the right host / path / method", () => {
  it("spot, USD-M and COIN-M each hit their own host", async () => {
    const { fn, calls } = stub((url) =>
      json(url.pathname.includes("dapi") ? coinmFixture : futuresFixture),
    );
    await withClient(fn, (c) =>
      Effect.all([c.spotAccount(CREDS), c.usdmAccount(CREDS), c.coinmAccount(CREDS)]),
    );
    expect(calls[0].request.url.origin).toBe(BINANCE_API_BASE);
    expect(calls[0].request.url.pathname).toBe("/api/v3/account");
    expect(calls[1].request.url.origin).toBe(BINANCE_FUTURES_API_BASE);
    expect(calls[1].request.url.pathname).toBe("/fapi/v2/account");
    expect(calls[2].request.url.origin).toBe(BINANCE_DELIVERY_API_BASE);
    expect(calls[2].request.url.pathname).toBe("/dapi/v1/account");
  });

  it("the funding account is a POST (params still go in the query)", async () => {
    const { fn, calls } = stub(() => json(fundingFixture));
    await withClient(fn, (c) => c.fundingAssets(CREDS));
    expect(calls[0].request.method).toBe("POST");
    expect(calls[0].request.url.pathname).toBe("/sapi/v1/asset/get-funding-asset");
    expect(calls[0].request.url.searchParams.has("signature")).toBe(true);
  });

  it("the three bases can each be overridden and are used as opaque strings (proxy)", async () => {
    const { fn, calls } = stub(() => json(futuresFixture));
    await withClient(fn, (c) => Effect.all([c.spotAccount(CREDS), c.usdmAccount(CREDS)]), {
      apiBase: "http://localhost:3099",
      fapiBase: "http://localhost:3098/fapi-proxy",
      dapiBase: "http://localhost:3097",
    });
    expect(calls[0].request.url.origin).toBe("http://localhost:3099");
    // A path prefix in the override is used as is: the client does not parse it.
    expect(calls[1].request.url.href).toContain("/fapi-proxy/fapi/v2/account");
  });
});

describe("tickerPrices", () => {
  it("an array becomes a symbol to price table", async () => {
    const { fn } = stub(() => json(tickerFixture));
    const table = await withClient(fn, (c) => c.tickerPrices);
    // Upstream gives string prices: the table needs numbers.
    expect(table.BTCUSDT).toBe(60000);
    expect(table.ETHUSDT).toBe(3000);
    expect(Object.keys(table)).toHaveLength(tickerFixture.length);
  });

  it("unsigned: no signature, no apiKey header", async () => {
    const { fn, calls } = stub(() => json(tickerFixture));
    await withClient(fn, (c) => c.tickerPrices);
    expect(calls[0].request.url.searchParams.has("signature")).toBe(false);
    // A public endpoint must not carry credential headers (the request's headers always exist, so the assertion is that it is not in there).
    expect(calls[0].request.headers["x-mbx-apikey"]).toBeUndefined();
  });
});

describe("pagination (earn)", () => {
  const rowsOf = (n: number, asset = "BTC") =>
    Array.from({ length: n }, () => ({ asset, totalAmount: "1" }));

  it("a last page (less than a full page) stops", async () => {
    const { fn, calls } = stub(() => json({ rows: rowsOf(3) }));
    const rows = await withClient(fn, (c) => c.earnFlexible(CREDS));
    expect(rows).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it("a full page continues, collecting everything", async () => {
    let page = 0;
    const { fn, calls } = stub(() => {
      page++;
      return json({ rows: page === 1 ? rowsOf(EARN_PAGE_SIZE) : rowsOf(7) });
    });
    const rows = await withClient(fn, (c) => c.earnFlexible(CREDS));
    expect(rows).toHaveLength(EARN_PAGE_SIZE + 7);
    expect(calls).toHaveLength(2);
    expect(calls[0].request.url.searchParams.get("current")).toBe("1");
    expect(calls[1].request.url.searchParams.get("current")).toBe("2");
    expect(calls[0].request.url.searchParams.get("size")).toBe(String(EARN_PAGE_SIZE));
  });

  it("stops once total is reached (even if this page is full)", async () => {
    const { fn, calls } = stub(() => json({ rows: rowsOf(EARN_PAGE_SIZE), total: EARN_PAGE_SIZE }));
    const rows = await withClient(fn, (c) => c.earnFlexible(CREDS));
    expect(rows).toHaveLength(EARN_PAGE_SIZE);
    expect(calls).toHaveLength(1);
  });

  it("the page-count guard catches an upstream that will not end", async () => {
    // Every page full and total lying as 0: without the guard it is an infinite loop.
    const { fn, calls } = stub(() => json({ rows: rowsOf(EARN_PAGE_SIZE), total: 0 }));
    const rows = await withClient(fn, (c) => c.earnFlexible(CREDS));
    expect(calls).toHaveLength(50); // EARN_MAX_PAGES
    expect(rows).toHaveLength(50 * EARN_PAGE_SIZE);
  });

  it("flexible and fixed-term each hit their own endpoint", async () => {
    const { fn, calls } = stub(() => json({ rows: [] }));
    await withClient(fn, (c) => Effect.all([c.earnFlexible(CREDS), c.earnLocked(CREDS)]));
    expect(calls[0].request.url.pathname).toBe("/sapi/v1/simple-earn/flexible/position");
    expect(calls[1].request.url.pathname).toBe("/sapi/v1/simple-earn/locked/position");
  });
});

describe("error classification", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ code: -1022, msg: "signature invalid" }, init));
    return failing(fn, (c) => c.spotAccount(CREDS));
  };

  // The one binance-specific classification (its `override`): the default rules would class 400 as "upstream's fault" and retry it, which is useless
  // and repeats a wrong credential; binance treats repeated auth failures as probing. The rest check the default rules do work here; the rules are tested in `@folio/client-core`.
  it("400 gives a credentials problem (binance uses 400 for a rejected signed request)", async () => {
    expect((await failWith({ status: 400 }))._tag).toBe("UpstreamAuthError");
  });

  it("401 / 403 give a credentials problem", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 is the same kind as 418, with Retry-After", async () => {
    for (const status of [429, 418]) {
      const err = await failWith({ status, headers: { "retry-after": "7" } });
      expect(err._tag).toBe("UpstreamRateLimitError");
      expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(7000);
    }
  });

  it("5xx gives unreachable", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("unreadable JSON gives parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.spotAccount(CREDS)))._tag).toBe("UpstreamParseError");
  });

  it("unreachable gives unreachable", async () => {
    const { fn } = stub(() => {
      throw new Error("dns");
    });
    expect((await failing(fn, (c) => c.spotAccount(CREDS)))._tag).toBe("UpstreamUnavailableError");
  });

  it("the failure info carries no query (signature / credentials are in it)", async () => {
    const err = await failWith({ status: 503 });
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.apiKey);
    expect(dump).not.toContain("signature=");
  });
});

describe("rate limiting: which endpoints pass the gate", () => {
  // This verifies structure, not the algorithm (the gate itself is tested in `@folio/client-core`): does the public endpoint pass the gate,
  // and is the signed endpoint deliberately not gated.
  // The `memory` tier is the official token bucket: limit 6 / 15s refills a token every 2500ms; the first 6 requests burst and the 7th waits.
  const settledAfter = (
    ms: number,
    use: (c: BinanceClientApi) => Effect.Effect<unknown, never, Outbound>,
  ) => {
    const fn = stub(() => json(tickerFixture)).fn;
    return runClient(
      fn,
      Effect.gen(function* () {
        const client = yield* make({});
        const fiber = yield* Effect.forkChild(use(client));
        yield* TestClock.adjust(Duration.millis(ms));
        // The fake egress is a `Promise.resolve`, which TestClock does not govern: advancing the virtual clock does not mean it has finished.
        // Polling after only adjusting would let the "not gated" side pass by luck. Yield a few microtask turns to drain it; the gated side
        // waits on the virtual clock and never completes however many turns, so both sides stay accurate.
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        return (yield* Effect.sync(() => fiber.pollUnsafe())) !== undefined;
      }),
    );
  };

  const nTimes =
    (n: number, one: (c: BinanceClientApi) => Effect.Effect<unknown, never, Outbound>) =>
    (c: BinanceClientApi) =>
      Effect.all(Array.from({ length: n }, () => one(c)));

  it("the public price table passes the gate: the request beyond the burst waits", async () => {
    const seven = nTimes(7, (c) => Effect.orDie(c.tickerPrices));
    expect(await settledAfter(2499, seven)).toBe(false);
    expect(await settledAfter(2500, seven)).toBe(true);
  });

  it("signed endpoints do not pass the gate: any number back to back, no waiting", async () => {
    // One request per account, no concurrency: a gate would block nothing and queue unrelated accounts.
    // Not written with the fork + poll above: the signed path has `crypto.subtle`, which on Node runs on the thread pool as a macrotask that
    // `yieldNow` (microtasks only) cannot advance, so a polled "not finished" would be false (it hung in full runs).
    // Instead run to the end and ask how far the virtual clock moved: 0ms means no request ever waited, independent of scheduling speed.
    const fn = stub(() => json(accountFixture)).fn;
    const elapsed = await runClient(
      fn,
      Effect.gen(function* () {
        const client = yield* make({});
        yield* nTimes(10, (c) => Effect.orDie(c.spotAccount(CREDS)))(client);
        return yield* Clock.currentTimeMillis;
      }),
    );

    expect(elapsed).toBe(0);
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `BinanceClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json(tickerFixture));
    const out = await runClient(
      fn,
      Effect.flatMap(BinanceClient, (client) => client.tickerPrices).pipe(
        Effect.provide(BinanceClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
