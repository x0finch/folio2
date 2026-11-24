import type { UpstreamError } from "@folio/upstream-basic";
import type { Outbound } from "@folio/upstreams";
import { type HttpStub, httpStub, jsonResponse as json, runClient } from "@folio/upstreams/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { make, OkxClient, type OkxClientApi, type OkxConfig } from "../src/client";
import {
  HEADER_KEY,
  HEADER_PASSPHRASE,
  HEADER_SIGN,
  HEADER_TIMESTAMP,
  OKX_API_BASE,
} from "../src/constants";
import balanceFixture from "./fixtures/balance.json" with { type: "json" };
import fundingFixture from "./fixtures/funding.json" with { type: "json" };
import valuationFixture from "./fixtures/valuation.json" with { type: "json" };

const CREDS = { apiKey: "the-key", secret: "the-secret", passphrase: "the-phrase" } as const;

// Reference implementation: does not call the code under test's `hmacSha256` but goes through WebCrypto independently; what is verified is which string was signed.
async function hmacB64(secret: string, message: string): Promise<string> {
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
  return btoa(String.fromCharCode(...sig));
}

// Fake egress that records every request. Replaces the `HttpClient` service, not `globalThis.fetch`, so the real path is exercised.
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// Construction is pure (no gate). Under TestClock the clock starts at 0, so the timestamp is 1970-01-01T00:00:00.000Z and the signing string is deterministic.
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: OkxClientApi) => Effect.Effect<A, E, Outbound>,
  config: OkxConfig = {},
): Promise<A> => runClient(fn, use(make(config)));

const failing = (
  fn: HttpStub,
  use: (c: OkxClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

const headersOf = (seen: { request: { headers: Record<string, string> } }) => seen.request.headers;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

describe("signing", () => {
  it("signs ISO timestamp + GET + requestPath, base64-encoded", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    await withClient(fn, (c) => c.balance(CREDS));

    const h = headersOf(calls[0]);
    // The timestamp is an ISO string, not milliseconds (differs from binance / Bybit).
    expect(h[HEADER_TIMESTAMP]).toBe(EPOCH_ISO);
    expect(h[HEADER_SIGN]).toBe(
      await hmacB64(CREDS.secret, `${EPOCH_ISO}GET/api/v5/account/balance`),
    );
  });

  it("requestPath must include the query when there is one: without it OKX answers 50113", async () => {
    // asset-valuation is the only endpoint with a query; the query goes through `makeRequester` as usual and the signing step rebuilds it, which this pins.
    const { fn, calls } = stub(() => json(valuationFixture));
    await withClient(fn, (c) => c.assetValuation(CREDS));

    expect(calls[0].request.url.searchParams.get("ccy")).toBe("USD");
    expect(headersOf(calls[0])[HEADER_SIGN]).toBe(
      await hmacB64(CREDS.secret, `${EPOCH_ISO}GET/api/v5/asset/asset-valuation?ccy=USD`),
    );
  });

  it("passphrase has its own header (binance / Bybit lack it)", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    await withClient(fn, (c) => c.balance(CREDS));
    const h = headersOf(calls[0]);
    expect(h[HEADER_PASSPHRASE]).toBe(CREDS.passphrase);
    expect(h[HEADER_KEY]).toBe(CREDS.apiKey);
  });

  it("secret and passphrase never go in the query", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    await withClient(fn, (c) => c.balance(CREDS));
    expect(calls[0].request.url.href).not.toContain(CREDS.secret);
    expect(calls[0].request.url.href).not.toContain(CREDS.passphrase);
  });
});

describe("endpoints hit the right path", () => {
  const paths: Array<
    [string, (c: OkxClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>]
  > = [
    ["/api/v5/account/balance", (c) => c.balance(CREDS)],
    ["/api/v5/asset/balances", (c) => c.fundingBalances(CREDS)],
    ["/api/v5/finance/savings/balance", (c) => c.savingsBalance(CREDS)],
    ["/api/v5/finance/staking-defi/orders-active", (c) => c.stakingOrders(CREDS)],
    ["/api/v5/asset/asset-valuation", (c) => c.assetValuation(CREDS)],
    ["/api/v5/account/positions", (c) => c.positions(CREDS)],
  ];

  for (const [path, call] of paths) {
    it(path, async () => {
      const { fn, calls } = stub(() => json({ code: "0", data: [] }));
      await withClient(fn, call);
      expect(calls[0].request.url.origin).toBe(OKX_API_BASE);
      expect(calls[0].request.url.pathname).toBe(path);
    });
  }

  it("apiBase can be overridden and is used as one opaque string (proxy)", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    await withClient(fn, (c) => c.balance(CREDS), { apiBase: "http://localhost:3099/okx-proxy" });
    expect(calls[0].request.url.href).toContain("/okx-proxy/api/v5/account/balance");
  });

  it("returns the upstream shape as is, no translation", async () => {
    const { fn } = stub(() => json(fundingFixture));
    expect(await withClient(fn, (c) => c.fundingBalances(CREDS))).toEqual(fundingFixture);
  });
});

describe("business codes (HTTP 200 + code)", () => {
  // Same trap as Bybit, but OKX's code is a string: unchecked, a signature error reads as success with empty data, i.e. "balance is 0".
  const withCode = (code: string, msg = "boom") => stub(() => json({ code, msg })).fn;

  it("credential / signature / permission codes give a credentials problem", async () => {
    // 50100 frozen / 50102 timestamp expired / 50105 wrong passphrase / 50111 invalid key / 50113 bad signature
    for (const code of ["50100", "50102", "50105", "50111", "50113"]) {
      expect((await failing(withCode(code), (c) => c.balance(CREDS)))._tag).toBe(
        "UpstreamAuthError",
      );
    }
  });

  it("other codes are upstream's fault", async () => {
    expect((await failing(withCode("51000"), (c) => c.balance(CREDS)))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("code and msg go into cause, not posing as an HTTP status", async () => {
    const err = await failing(withCode("50113", "Invalid Sign"), (c) => c.balance(CREDS));
    expect(err.status).toBeUndefined();
    expect(String(err.cause)).toContain("code 50113");
    expect(String(err.cause)).toContain("Invalid Sign");
  });

  it("all six endpoints check the code", async () => {
    const fn = withCode("50113");
    const calls: Array<(c: OkxClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>> = [
      (c) => c.balance(CREDS),
      (c) => c.fundingBalances(CREDS),
      (c) => c.savingsBalance(CREDS),
      (c) => c.stakingOrders(CREDS),
      (c) => c.assetValuation(CREDS),
      (c) => c.positions(CREDS),
    ];
    for (const call of calls) {
      expect((await failing(fn, call))._tag).toBe("UpstreamAuthError");
    }
  });
});

it("upstream returns a bare null: parse, not a crash", async () => {
  // `null` is a legal 200 JSON; reading its fields would throw a TypeError, a defect that never reaches the error channel.
  const { fn } = stub(() => json(null));
  expect((await failing(fn, (c) => c.balance(CREDS)))._tag).toBe("UpstreamParseError");
});

describe("HTTP-level error classification", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ code: "0" }, init));
    return failing(fn, (c) => c.balance(CREDS));
  };

  it("401 / 403 give a credentials problem", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 gives rate-limited, with Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "4" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(4000);
  });

  it("5xx gives unreachable", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("unreadable JSON gives parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.balance(CREDS)))._tag).toBe("UpstreamParseError");
  });

  it("the failure info carries no credentials", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("okx");
    expect(err.where).toBe("/api/v5/account/balance");
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.passphrase);
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `OkxClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    const out = await runClient(
      fn,
      Effect.flatMap(OkxClient, (client) => client.balance(CREDS)).pipe(
        Effect.provide(OkxClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
