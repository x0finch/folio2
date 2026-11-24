import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { type HttpStub, httpStub, runClient } from "@folio/upstreams/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { zerionProvider } from "../../../src/connectors/evm/zerion-provider";
import chains from "./fixtures/zerion-chains.json";
import expected from "./fixtures/zerion-expected-balances.json";
import positions from "./fixtures/zerion-positions.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const KEY = "zerion-key";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes("/v1/chains")) return json(chains);
    if (path.includes("/positions")) return json(positions);
    return json({}); // portfolio
  });
}

type Ctx = Parameters<typeof zerionProvider.fetchBalances>[0];
const PROVIDER_CREDS = { ZERION_API_KEY: KEY };
const ctx = (providerCreds: Record<string, string> = PROVIDER_CREDS): Ctx =>
  ({
    account: { id: "a1", label: "EVM", connectorId: "evm", creds: { address: ADDR } },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  // This must be first: the chain mapping is cached 24h in the client at module level (on CF Workers a Scope would reset it every request).
  // Only while nobody has fetched the chain list yet is a fetch failure a hard failure; after that it falls to the old value (the second case below).
  it("cold start + chain list down: whole failure, never writing a snapshot with forked identifiers", async () => {
    // Without a numeric chainId the canonical `evm:<chainId>` cannot be produced, and degrading to the slug fallback form would split identity
    // from the canonical one and pollute the token index. Failing means nothing is produced; the whole round retries.
    const stub = upstream({ "/v1/chains": () => json({}, { status: 500 }) });
    const err = await failing(stub, zerionProvider.fetchBalances(ctx()));
    expect(err._tag).toBe("UpstreamUnavailableError");
  });

  it("positions and chain mapping fetched concurrently, output matches the golden", async () => {
    const stub = upstream();
    const { balances } = await run(stub, zerionProvider.fetchBalances(ctx()));
    expect(balances).toEqual(expected);
  });

  it("after one fetch the chain list goes down: falls back to the old mapping and balances come out as usual (one of the cache's three reasons)", async () => {
    const stub = upstream({ "/v1/chains": () => json({}, { status: 500 }) });
    const { balances } = await run(stub, zerionProvider.fetchBalances(ctx()));
    // A chain's chainId is immutable, so the old mapping is still correct: better than failing the whole round.
    expect(balances).toEqual(expected);
  });

  it("Basic auth: key as username, empty password", async () => {
    const stub = upstream();
    await run(stub, zerionProvider.fetchBalances(ctx()));
    const auth = stub.calls[0].request.headers.authorization;
    expect(auth).toBe(`Basic ${btoa(`${KEY}:`)}`);
    // The declared key is the one injected here and read to sign the header (the app injects ctx.creds from env per the declaration).
    // (The backup source's defaultEnabled=false is pinned by registry.test.)
    expect(zerionProvider.creds.map((f) => f.key)).toEqual(Object.keys(PROVIDER_CREDS));
  });

  it("no provider key configured: a credentials problem, and no request at all", async () => {
    const stub = upstream();
    const err = await failing(stub, zerionProvider.fetchBalances(ctx({})));
    expect(err._tag).toBe("UpstreamAuthError");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("validateAccount", () => {
  it("200 gives true (hits the light portfolio)", async () => {
    const stub = httpStub(() => json({}));
    expect(await run(stub, zerionProvider.validateAccount(ctx()))).toBe(true);
    expect(stub.calls[0].request.url.pathname).toContain("portfolio");
  });

  it("no key configured: false, and no request at all", async () => {
    const stub = httpStub(() => json({}));
    expect(await run(stub, zerionProvider.validateAccount(ctx({})))).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("credentials rejected (401): false; 5xx goes through the error channel", async () => {
    const denied = httpStub(() => json({}, { status: 401 }));
    expect(await run(denied, zerionProvider.validateAccount(ctx()))).toBe(false);
    const down = httpStub(() => json({}, { status: 503 }));
    expect((await failing(down, zerionProvider.validateAccount(ctx())))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });
});
