import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { zerionBalance } from "../../../src/balance/zerion/upstream";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../../src/runtime/testing";
import chains from "./fixtures/chains.json";
import expected from "./fixtures/expected-balances.json";
import positions from "./fixtures/positions.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const KEY = "zerion-key";
const PROVIDER_CREDS = { ZERION_API_KEY: KEY };
const CHAINS = "/v1/chains/";

function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes(CHAINS)) return json(chains);
    if (path.includes("/positions")) return json(positions);
    return json({}); // portfolio
  });
}

type Ctx = Parameters<typeof zerionBalance.fetchBalances>[0];
const ctx = (providerCreds: Record<string, string> = PROVIDER_CREDS): Ctx =>
  ({
    account: { id: "a1", label: "EVM", connectorId: "evm", creds: { address: ADDR } },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A, E>(stub: HttpStub, effect: Effect.Effect<A, E, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

const chainCalls = (stub: HttpStub) =>
  stub.calls.filter((c) => c.request.url.pathname === CHAINS).length;

// The chain map is cached at module level for the one production base, so the order of this
// block is part of what it checks: only the first case sees a cold cache.
describe("fetchBalances, in order", () => {
  it("cold start + chain list down: whole failure, never non-canonical refs", async () => {
    const stub = upstream({ [CHAINS]: () => json({}, { status: 500 }) });
    const err = await failing(stub, zerionBalance.fetchBalances(ctx()));
    expect(err._tag).toBe("UpstreamUnavailableError");
  });

  it("an empty chain list counts as not fetched", async () => {
    const stub = upstream({ [CHAINS]: () => json({ data: [] }) });
    const err = await failing(stub, zerionBalance.fetchBalances(ctx()));
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe("zerion");
  });

  it("concurrent cold accounts fetch the chain list once, and match the golden", async () => {
    const stub = upstream();
    const results = await run(
      stub,
      Effect.all(
        [1, 2, 3].map(() => zerionBalance.fetchBalances(ctx())),
        {
          concurrency: "unbounded",
        },
      ),
    );
    for (const { balances } of results) expect(balances).toEqual(expected);
    expect(chainCalls(stub)).toBe(1);
  });

  it("cached: the next account sends only positions", async () => {
    const stub = upstream();
    await run(stub, zerionBalance.fetchBalances(ctx()));
    expect(chainCalls(stub)).toBe(0);
  });

  it("after the TTL a refresh failure falls back to the old map (chainIds are immutable)", async () => {
    const stub = upstream({ [CHAINS]: () => json({}, { status: 500 }) });
    const { balances } = await run(
      stub,
      Effect.andThen(TestClock.adjust(Duration.hours(25)), zerionBalance.fetchBalances(ctx())),
    );
    expect(chainCalls(stub)).toBe(1);
    expect(balances).toEqual(expected);
  });
});

describe("request shape", () => {
  it("Basic auth: key as username, empty password, never in the query", async () => {
    const stub = upstream();
    await run(stub, zerionBalance.fetchBalances(ctx()));
    const sent = stub.calls[0].request;
    expect(atob(sent.headers.authorization.slice("Basic ".length))).toBe(`${KEY}:`);
    expect(sent.url.search).not.toContain(KEY);
    expect(zerionBalance.creds.map((f) => f.key)).toEqual(Object.keys(PROVIDER_CREDS));
    expect(zerionBalance.creds.every((f) => f.type === "secret")).toBe(true);
  });

  it("positions carry the three filters (without no_filter no DeFi row comes back)", async () => {
    const stub = upstream();
    await run(stub, zerionBalance.fetchBalances(ctx()));
    const url = stub.calls.find((c) => c.request.url.pathname.includes("/positions"))!.request.url;
    expect(url.href.startsWith(`https://api.zerion.io/v1/wallets/${ADDR}/positions/`)).toBe(true);
    expect(url.searchParams.get("filter[positions]")).toBe("no_filter");
    expect(url.searchParams.get("filter[trash]")).toBe("only_non_trash");
    expect(url.searchParams.get("currency")).toBe("usd");
  });

  it("disabled by default: a fallback source", () => {
    expect(zerionBalance.defaultEnabled).toBe(false);
  });
});

describe("failure classification", () => {
  const failWith = (init: ResponseInit) =>
    failing(
      upstream({ "/positions": () => json({ errors: [{ title: "nope" }] }, init) }),
      zerionBalance.fetchBalances(ctx()),
    );

  it("errors carry neither the key nor the query", async () => {
    const dump = JSON.stringify(await failWith({ status: 503 }));
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("filter[trash]");
  });
});

describe("validateAccount", () => {
  it("200 gives true, from the light portfolio", async () => {
    const stub = httpStub(() => json({}));
    expect(await run(stub, zerionBalance.validateAccount(ctx()))).toBe(true);
    expect(stub.calls[0].request.url.pathname).toBe(`/v1/wallets/${ADDR}/portfolio`);
  });
});
