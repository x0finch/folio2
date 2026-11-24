import { isRetryable, type UpstreamError, type UpstreamNeeds } from "@folio/upstream-basic";
import { Clock, Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { tickerPrices } from "../../../src/balance/binance/api";
import { EARN_PAGE_SIZE } from "../../../src/balance/binance/constants";
import { binance, binanceBalance } from "../../../src/balance/binance/upstream";
import {
  type HttpClientRequestLike,
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../../src/runtime/testing";
import account from "./fixtures/account.json";
import coinmAccount from "./fixtures/coinm-account.json";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnLocked from "./fixtures/earn-locked.json";
import fundingAssets from "./fixtures/funding-assets.json";
import futuresAccount from "./fixtures/futures-account.json";
import ticker from "./fixtures/ticker-price.json";

const CREDS = { apiKey: "the-key", secret: "the-secret" };

// An independent reference: what is checked is which string was signed.
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

// Routes by pathname; anything not given answers as an empty account.
function upstream(
  routes: Record<string, (request: HttpClientRequestLike) => Response> = {},
): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply(request);
    }
    if (path.includes("/dapi/v1/account")) return json({ assets: [], positions: [] });
    if (path.includes("/fapi/v2/account")) return json({ totalMarginBalance: "0", positions: [] });
    if (path.includes("/api/v3/account")) return json({ balances: [] });
    if (path.includes("/simple-earn/")) return json({ rows: [], total: 0 });
    if (path.includes("/sapi/")) return json([]);
    return json(ticker);
  });
}

const full = () =>
  upstream({
    "/simple-earn/flexible/position": () => json(earnFlexible),
    "/simple-earn/locked/position": () => json(earnLocked),
    "/get-funding-asset": () => json(fundingAssets),
    "/dapi/v1/account": () => json(coinmAccount),
    "/fapi/v2/account": () => json(futuresAccount),
    "/api/v3/account": () => json(account),
  });

type Ctx = Parameters<typeof binanceBalance.fetchBalances>[0];
const ctx = (providerCreds: Record<string, string> = {}): Ctx =>
  ({
    account: { id: "a1", label: "Binance", connectorId: "binance", creds: CREDS },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

const sentTo = (stub: HttpStub, fragment: string) =>
  stub.calls.find((c) => c.request.url.pathname.includes(fragment))?.request;

describe("signing", () => {
  it("signs the query in send order, appends signature last, apiKey in a header", async () => {
    const stub = upstream();
    await run(stub, binanceBalance.validateAccount(ctx()));
    const { url, headers } = stub.calls[0].request;
    const sent = [...url.searchParams.entries()];
    // TestClock starts at 0.
    expect(sent.map(([k]) => k)).toEqual(["recvWindow", "timestamp", "signature"]);
    expect(url.searchParams.get("signature")).toBe(
      await hmacHex(CREDS.secret, "recvWindow=5000&timestamp=0"),
    );
    expect(headers["X-MBX-APIKEY"]).toBe(CREDS.apiKey);
    expect(url.href).not.toContain(CREDS.apiKey);
    expect(url.href).not.toContain(CREDS.secret);
  });

  it("paged earn requests sign their page params too", async () => {
    const stub = upstream();
    await run(stub, binanceBalance.fetchBalances(ctx()));
    const sent = sentTo(stub, "/simple-earn/flexible/position");
    expect(sent?.url.searchParams.get("signature")).toBe(
      await hmacHex(CREDS.secret, `current=1&size=${EARN_PAGE_SIZE}&recvWindow=5000&timestamp=0`),
    );
  });

  it("the public ticker carries neither signature nor key", async () => {
    const stub = upstream();
    await run(stub, binanceBalance.fetchBalances(ctx()));
    const sent = sentTo(stub, "/ticker/price");
    expect(sent?.url.search).toBe("");
    expect(sent?.headers["X-MBX-APIKEY"]).toBeUndefined();
  });
});

describe("fetchBalances", () => {
  it("five wallets on three hosts: spot / funding / earn priced by the ticker, perps by themselves", async () => {
    const stub = full();
    const { balances, note } = await run(stub, binanceBalance.fetchBalances(ctx()));

    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(8); // spot 4 + funding 2 + earn 2
    expect(balances.filter((b) => b.kind === "perp_equity")).toHaveLength(2); // USDⓈ-M + COIN-M
    expect(balances.filter((b) => b.kind === "perp_position")).toHaveLength(4);
    expect(balances.find((b) => b.symbol === "ETH" && !b.note?.group)?.note).toEqual({
      title: "Locked",
      icon: "warning",
      content: "1 ETH · 33%",
    });
    expect(note).toBeUndefined();

    const origin = (fragment: string) => sentTo(stub, fragment)?.url.origin;
    expect(origin("/api/v3/account")).toBe("https://api.binance.com");
    expect(origin("/fapi/v2/account")).toBe("https://fapi.binance.com");
    expect(origin("/dapi/v1/account")).toBe("https://dapi.binance.com");
    expect(sentTo(stub, "/get-funding-asset")?.method).toBe("POST");
  });

  it("earn pages until a short page, so later rows aren't lost", async () => {
    const rowsOf = (n: number, asset: string) =>
      Array.from({ length: n }, () => ({ asset, totalAmount: "1" }));
    const stub = upstream({
      "/simple-earn/flexible/position": (request) =>
        json({
          rows:
            request.url.searchParams.get("current") === "1"
              ? rowsOf(EARN_PAGE_SIZE, "A")
              : rowsOf(7, "UNI"),
        }),
    });
    const { balances } = await run(stub, binanceBalance.fetchBalances(ctx()));
    expect(balances.filter((b) => b.note?.group === "earn")).toHaveLength(EARN_PAGE_SIZE + 7);
    expect(balances.some((b) => b.symbol === "UNI")).toBe(true);
    const pages = stub.calls.filter((c) => c.request.url.pathname.includes("/flexible/"));
    expect(pages.map((c) => c.request.url.searchParams.get("size"))).toEqual(["100", "100"]);
  });

  it("earn stops at `total`, and the page cap stops an upstream that never ends", async () => {
    const pages = (body: unknown) =>
      upstream({ "/simple-earn/flexible/position": () => json(body) });
    const rows = Array.from({ length: EARN_PAGE_SIZE }, () => ({ asset: "A", totalAmount: "1" }));
    const atTotal = pages({ rows, total: EARN_PAGE_SIZE });
    await run(atTotal, binanceBalance.fetchBalances(ctx()));
    const flexibleCalls = (stub: HttpStub) =>
      stub.calls.filter((c) => c.request.url.pathname.includes("/flexible/")).length;
    expect(flexibleCalls(atTotal)).toBe(1);
    const endless = pages({ rows, total: 0 });
    await run(endless, binanceBalance.fetchBalances(ctx()));
    expect(flexibleCalls(endless)).toBe(50);
  });

  it("one wallet lacks permission (401): the rest + a note naming exactly that wallet", async () => {
    const stub = upstream({
      "/get-funding-asset": () => json({}, { status: 401 }),
      "/api/v3/account": () => json(account),
    });
    const { balances, note } = await run(stub, binanceBalance.fetchBalances(ctx()));
    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(4);
    expect(note).toEqual([
      {
        title: "Wallets not synced",
        icon: "warning",
        content: "Funding — check the API key's permissions",
      },
    ]);
  });

  it("a transient wallet failure fails the whole account into retry", async () => {
    const stub = upstream({ "/fapi/v2/account": () => json({}, { status: 503 }) });
    expect(isRetryable(await failing(stub, binanceBalance.fetchBalances(ctx())))).toBe(true);
  });

  // Degrading would write a futures-only snapshot that hides the real holdings.
  it("ticker down while a priced wallet was read: the whole account fails, retryable", async () => {
    const stub = upstream({
      "/ticker/price": () => json({}, { status: 429 }),
      "/get-funding-asset": () => json({}, { status: 401 }),
      "/api/v3/account": () => json(account),
      "/fapi/v2/account": () => json(futuresAccount),
    });
    const err = await failing(stub, binanceBalance.fetchBalances(ctx()));
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(isRetryable(err)).toBe(true);
  });

  it("ticker down but every priced wallet failed on its own call: still best effort with USDⓈ-M", async () => {
    const denied = () => json({}, { status: 401 });
    const stub = upstream({
      "/ticker/price": () => json({}, { status: 429 }),
      "/api/v3/account": denied,
      "/get-funding-asset": denied,
      "/dapi/v1/account": denied,
      "/simple-earn/": denied,
      "/fapi/v2/account": () => json(futuresAccount),
    });
    const { balances, note } = await run(stub, binanceBalance.fetchBalances(ctx()));
    expect(balances.every((b) => b.kind !== "spot")).toBe(true);
    expect(balances.some((b) => b.kind === "perp_equity")).toBe(true);
    expect(note?.[0]?.content).toBe(
      "Spot / COIN-M Futures / Funding / Earn — check the API key's permissions",
    );
  });

  it("everything fails: failure, never an empty snapshot", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    expect((await failing(stub, binanceBalance.fetchBalances(ctx())))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("each of the three base overrides takes effect; they are the only env names, public", async () => {
    const overrides = {
      BINANCE_API_BASE: "https://px.example/s/binance",
      BINANCE_FAPI_BASE: "https://px.example/s/binance-fapi",
      BINANCE_DAPI_BASE: "https://px.example/s/binance-dapi",
    };
    expect(binanceBalance.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(binanceBalance.creds.every((f) => f.type === "public")).toBe(true);

    const stub = upstream();
    await run(stub, binanceBalance.fetchBalances(ctx(overrides)));
    const urls = stub.calls.map((c) => c.request.url.href);
    const hit = (prefix: string) => urls.some((u) => u.startsWith(prefix));
    expect(hit("https://px.example/s/binance/api/v3/account")).toBe(true);
    expect(hit("https://px.example/s/binance/api/v3/ticker/price")).toBe(true);
    expect(hit("https://px.example/s/binance-fapi/fapi/v2/account")).toBe(true);
    expect(hit("https://px.example/s/binance-dapi/dapi/v1/account")).toBe(true);
    expect(urls.some((u) => u.includes("binance.com"))).toBe(false);
  });
});

describe("failure classification", () => {
  const failWith = (init: ResponseInit) =>
    failing(
      httpStub(() => json({ code: -1022, msg: "Signature invalid" }, init)),
      binanceBalance.validateAccount(ctx()),
    );

  it("400 (a rejected signed request) and 401 / 403 are rejected credentials, sent once", async () => {
    for (const status of [400, 401, 403]) {
      const stub = httpStub(() => json({ code: -1022 }, { status }));
      expect(await run(stub, binanceBalance.validateAccount(ctx()))).toBe(false);
      expect(stub.calls).toHaveLength(1);
    }
  });

  it("429 and 418 (the IP ban) are both rate-limited, with Retry-After", async () => {
    for (const status of [429, 418]) {
      const err = await failWith({ status, headers: { "retry-after": "7" } });
      expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(7000);
    }
  });

  it("5xx and network failures are unavailable; unreadable JSON is parse", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
    const offline = httpStub(() => {
      throw new Error("dns");
    });
    expect((await failing(offline, binanceBalance.validateAccount(ctx())))._tag).toBe(
      "UpstreamUnavailableError",
    );
    const html = httpStub(() => new Response("<html>", { status: 200 }));
    expect((await failing(html, binanceBalance.validateAccount(ctx())))._tag).toBe(
      "UpstreamParseError",
    );
  });

  it("errors carry no credentials and no query", async () => {
    const dump = JSON.stringify(await failWith({ status: 503 }));
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.apiKey);
    expect(dump).not.toContain("signature=");
  });
});

describe("rate limiting", () => {
  it("the ticker is gated: past the burst of 6 the next waits one refill (2.5 s)", async () => {
    const stub = httpStub(() => json(ticker));
    const settledAfter = (ms: number) =>
      runClient(
        stub,
        Effect.gen(function* () {
          const call = yield* binance.connect({});
          const fiber = yield* Effect.forkChild(
            Effect.all(Array.from({ length: 7 }, () => tickerPrices(call))),
          );
          yield* TestClock.adjust(Duration.millis(ms));
          // The stub resolves on microtasks TestClock doesn't drive; drain them before polling.
          yield* Effect.repeat(Effect.yieldNow, { times: 50 });
          return fiber.pollUnsafe() !== undefined;
        }),
      );
    expect(await settledAfter(2499)).toBe(false);
    expect(await settledAfter(2500)).toBe(true);
  });

  it("signed calls are not gated: any number back to back, no virtual time passes", async () => {
    const stub = httpStub(() => json(account));
    const elapsed = await runClient(
      stub,
      Effect.gen(function* () {
        for (let i = 0; i < 10; i++) yield* binanceBalance.validateAccount(ctx());
        return yield* Clock.currentTimeMillis;
      }),
    );
    expect(elapsed).toBe(0);
  });
});

describe("validateAccount", () => {
  it("200 → true, from the spot account only", async () => {
    const stub = httpStub(() => json(account));
    expect(await run(stub, binanceBalance.validateAccount(ctx()))).toBe(true);
    expect(stub.calls.map((c) => c.request.url.pathname)).toEqual(["/api/v3/account"]);
  });
});
