import type { Outbound, UpstreamError } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { BybitClient, type BybitClientApi, type BybitConfig, make } from "../src/client";
import {
  BYBIT_API_BASE,
  EARN_CATEGORY_FLEXIBLE,
  HEADER_KEY,
  HEADER_RECV_WINDOW,
  HEADER_SIGN,
  HEADER_SIGN_TYPE,
  HEADER_TIMESTAMP,
  RECV_WINDOW,
} from "../src/constants";
import earnFixture from "./fixtures/earn-flexible.json" with { type: "json" };
import fundingFixture from "./fixtures/funding.json" with { type: "json" };
import walletFixture from "./fixtures/wallet-balance.json" with { type: "json" };

const CREDS = { apiKey: "the-key", secret: "the-secret" } as const;

// Reference implementation: does not call the code under test's `hmacSha256` but goes through WebCrypto independently; what is verified is which
// string was signed (the HMAC algorithm itself is WebCrypto's guarantee).
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

// Fake egress that records every request. Replaces the `HttpClient` service, not `globalThis.fetch`, so the real path is exercised.
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// Construction is pure (no gate, so no Scope). Under TestClock `Clock.currentTimeMillis` starts at 0, so the signing string is deterministic and can be checked against the reference.
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: BybitClientApi) => Effect.Effect<A, E, Outbound>,
  config: BybitConfig = {},
): Promise<A> => runClient(fn, use(make(config)));

const failing = (
  fn: HttpStub,
  use: (c: BybitClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

const headersOf = (seen: { request: { headers: Record<string, string> } }) => seen.request.headers;

describe("signing", () => {
  it("signs timestamp + apiKey + recvWindow + queryString, and matches the sent query byte for byte", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS));

    const h = headersOf(calls[0]);
    // The query actually sent: the signed string must use it, not a separately built version.
    const sentQuery = calls[0].request.url.searchParams.toString();
    expect(sentQuery).toBe("accountType=UNIFIED");
    // Under TestClock the timestamp is 0.
    expect(h[HEADER_TIMESTAMP]).toBe("0");
    expect(h[HEADER_SIGN]).toBe(
      await hmacHex(CREDS.secret, `0${CREDS.apiKey}${RECV_WINDOW}${sentQuery}`),
    );
  });

  it("all five signature headers are sent (without one Bybit answers 10004)", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS));
    const h = headersOf(calls[0]);
    expect(h[HEADER_KEY]).toBe(CREDS.apiKey);
    expect(h[HEADER_RECV_WINDOW]).toBe(RECV_WINDOW);
    expect(h[HEADER_SIGN_TYPE]).toBe("2");
    expect(h[HEADER_SIGN]).toBeTruthy();
  });

  it("the secret is neither in the query nor the headers", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS));
    expect(calls[0].request.url.href).not.toContain(CREDS.secret);
    expect(JSON.stringify(headersOf(calls[0]))).not.toContain(CREDS.secret);
  });
});

describe("endpoints hit the right path / query", () => {
  it("unified account: accountType=UNIFIED", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS));
    expect(calls[0].request.url.origin).toBe(BYBIT_API_BASE);
    expect(calls[0].request.url.pathname).toBe("/v5/account/wallet-balance");
    expect(calls[0].request.url.searchParams.get("accountType")).toBe("UNIFIED");
  });

  it("funding account: accountType=FUND", async () => {
    const { fn, calls } = stub(() => json(fundingFixture));
    await withClient(fn, (c) => c.fundingBalances(CREDS));
    expect(calls[0].request.url.pathname).toBe("/v5/asset/transfer/query-account-coins-balance");
    expect(calls[0].request.url.searchParams.get("accountType")).toBe("FUND");
  });

  it("earn: category is given by the caller (which categories to fetch is the adapter's call)", async () => {
    const { fn, calls } = stub(() => json(earnFixture));
    await withClient(fn, (c) => c.earnPositions(CREDS, EARN_CATEGORY_FLEXIBLE));
    expect(calls[0].request.url.pathname).toBe("/v5/earn/position");
    expect(calls[0].request.url.searchParams.get("category")).toBe("FlexibleSaving");
  });

  it("apiBase can be overridden and is used as one opaque string (proxy)", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS), {
      apiBase: "http://localhost:3099/bybit-proxy",
    });
    expect(calls[0].request.url.href).toContain("/bybit-proxy/v5/account/wallet-balance");
  });

  it("returns the upstream shape as is, no translation", async () => {
    const { fn } = stub(() => json(walletFixture));
    const res = await withClient(fn, (c) => c.walletBalance(CREDS));
    expect(res).toEqual(walletFixture);
  });
});

describe("business codes (HTTP 200 + retCode)", () => {
  // The easiest trap with Bybit: unchecked, a signature error reads as success with empty result, i.e. "balance is 0", silently losing data.
  const withRetCode = (retCode: number, retMsg = "boom") =>
    stub(() => json({ retCode, retMsg })).fn;

  it("credential / signature / permission retCodes give a credentials problem", async () => {
    // 10003 invalid key / 10004 bad signature / 10005 permission denied / 10010 IP mismatch / 33004 key expired
    for (const code of [10003, 10004, 10005, 10010, 33004]) {
      const err = await failing(withRetCode(code), (c) => c.walletBalance(CREDS));
      expect(err._tag).toBe("UpstreamAuthError");
    }
  });

  it("other retCodes are upstream's fault", async () => {
    const err = await failing(withRetCode(10016), (c) => c.walletBalance(CREDS));
    expect(err._tag).toBe("UpstreamUnavailableError");
  });

  it("retCode and retMsg go into cause, not posing as an HTTP status", async () => {
    // Mixed into `status`, a log reader could not tell whether "503" and "10004" are the same kind of thing.
    const err = await failing(withRetCode(10004, "sign check error"), (c) =>
      c.walletBalance(CREDS),
    );
    expect(err.status).toBeUndefined();
    expect(String(err.cause)).toContain("retCode 10004");
    expect(String(err.cause)).toContain("sign check error");
  });

  it("all three endpoints check retCode", async () => {
    const fn = withRetCode(10004);
    expect((await failing(fn, (c) => c.fundingBalances(CREDS)))._tag).toBe("UpstreamAuthError");
    expect((await failing(fn, (c) => c.earnPositions(CREDS, "OnChain")))._tag).toBe(
      "UpstreamAuthError",
    );
  });
});

it("upstream returns a bare null: parse, not a crash", async () => {
  // `null` is a legal 200 JSON; reading its fields would throw a TypeError, a defect that never reaches the error channel.
  const { fn } = stub(() => json(null));
  expect((await failing(fn, (c) => c.walletBalance(CREDS)))._tag).toBe("UpstreamParseError");
});

describe("HTTP-level error classification", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ retCode: 0 }, init));
    return failing(fn, (c) => c.walletBalance(CREDS));
  };

  it("401 / 403 give a credentials problem", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 gives rate-limited, with Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "2" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(2000);
  });

  it("5xx gives unreachable", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("unreadable JSON gives parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.walletBalance(CREDS)))._tag).toBe("UpstreamParseError");
  });

  it("the failure info carries no secret / query", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("bybit");
    expect(err.where).toBe("/v5/account/wallet-balance");
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.apiKey);
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `BybitClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    const out = await runClient(
      fn,
      Effect.flatMap(BybitClient, (client) => client.walletBalance(CREDS)).pipe(
        Effect.provide(BybitClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
