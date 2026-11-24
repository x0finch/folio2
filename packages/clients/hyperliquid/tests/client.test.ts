import type { Outbound, UpstreamError } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  HyperliquidClient,
  type HyperliquidClientApi,
  type HyperliquidConfig,
  make,
} from "../src/client";
import { CLEARINGHOUSE_TYPE, HYPERLIQUID_API_BASE } from "../src/constants";
import stateFixture from "./fixtures/clearinghouse-state.json" with { type: "json" };

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// Fake egress that records every request. Replaces the `HttpClient` service, not `globalThis.fetch`, so the real path is exercised.
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// Construction is pure (no gate, so no Scope), so the client is not built inside an Effect here, unlike binance's `withClient`.
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: HyperliquidClientApi) => Effect.Effect<A, E, Outbound>,
  config: HyperliquidConfig = {},
): Promise<A> => runClient(fn, use(make(config)));

const failing = (
  fn: HttpStub,
  use: (c: HyperliquidClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

describe("clearinghouseState", () => {
  it("POST /info, with type and user in the body", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR));

    expect(calls[0].request.url.origin).toBe(HYPERLIQUID_API_BASE);
    expect(calls[0].request.url.pathname).toBe("/info");
    expect(calls[0].request.method).toBe("POST");
    expect(JSON.parse(String(calls[0].request.body))).toEqual({
      type: CLEARINGHOUSE_TYPE,
      user: ADDR,
    });
  });

  it("sends content-type: application/json (upstream answers 422 without it)", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR));
    expect(calls[0].request.headers["content-type"]).toBe("application/json");
  });

  it("values are not translated, but only declared fields come out: extras from upstream are dropped", async () => {
    // The client's output is the DTO: numbers stay strings, parsing belongs to the adapter.
    const { fn } = stub(() => json(stateFixture));
    const state = await withClient(fn, (c) => c.clearinghouseState(ADDR));

    // Declared fields are untouched.
    expect(state.marginSummary).toEqual(stateFixture.marginSummary);
    expect(typeof state.marginSummary?.accountValue).toBe("string");
    expect(state.assetPositions?.[0].position).toEqual(stateFixture.assetPositions[0].position);

    // Undeclared ones are dropped (schema default): `assetPositions[].type` in the fixture was never read, so it should not leave with the DTO.
    expect("type" in stateFixture.assetPositions[0]).toBe(true);
    expect("type" in state.assetPositions![0]).toBe(false);
  });

  it("the address is passed per call: one client serves many accounts", async () => {
    const other = "0x0000000000000000000000000000000000000001";
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) =>
      Effect.all([c.clearinghouseState(ADDR), c.clearinghouseState(other)]),
    );
    expect(JSON.parse(String(calls[0].request.body)).user).toBe(ADDR);
    expect(JSON.parse(String(calls[1].request.body)).user).toBe(other);
  });

  it("apiBase can be overridden and is used as one opaque string", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR), {
      apiBase: "http://localhost:3099/hl-proxy",
    });
    expect(calls[0].request.url.href).toContain("/hl-proxy/info");
  });
});

describe("error classification", () => {
  // Hyperliquid has no classification difference (the info endpoint has no auth, so "credentials rejected" cannot occur);
  // these check that core's default rules do work on this path.
  it("429 gives rate-limited, with Retry-After", async () => {
    const { fn } = stub(() => json({}, { status: 429, headers: { "retry-after": "7" } }));
    const err = await failing(fn, (c) => c.clearinghouseState(ADDR));
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(7000);
  });

  it("5xx / unreachable give unreachable", async () => {
    const { fn: down } = stub(() => json({}, { status: 503 }));
    expect((await failing(down, (c) => c.clearinghouseState(ADDR)))._tag).toBe(
      "UpstreamUnavailableError",
    );
    const { fn: dead } = stub(() => {
      throw new Error("dns");
    });
    expect((await failing(dead, (c) => c.clearinghouseState(ADDR)))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("unreadable JSON gives parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.clearinghouseState(ADDR)))._tag).toBe("UpstreamParseError");
  });

  it("errors carry `upstream`, answering who failed", async () => {
    const { fn } = stub(() => json({}, { status: 503 }));
    expect((await failing(fn, (c) => c.clearinghouseState(ADDR))).upstream).toBe("hyperliquid");
  });

  it("the failure info carries no query / address", async () => {
    const { fn } = stub(() => json({}, { status: 503 }));
    const err = await failing(fn, (c) => c.clearinghouseState(ADDR));
    expect(err.where).toBe("/info");
    expect(JSON.stringify(err)).not.toContain(ADDR);
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `HyperliquidClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    const out = await runClient(
      fn,
      Effect.flatMap(HyperliquidClient, (client) => client.clearinghouseState(ADDR)).pipe(
        Effect.provide(HyperliquidClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
