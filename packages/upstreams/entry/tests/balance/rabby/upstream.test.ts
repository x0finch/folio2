import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { RabbySigner, type SignRequest } from "../../../src/balance/rabby/signer";
import { rabbyBalance } from "../../../src/balance/rabby/upstream";
import { SigningFailure } from "../../../src/runtime/errors";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../../src/runtime/testing";
import tokens from "./fixtures/cache-token-list.json";
import chains from "./fixtures/chain-list.json";
import protocols from "./fixtures/complex-protocol-list.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SIGNATURE_HEADERS = [
  "X-Api-Ts",
  "X-Api-Nonce",
  "X-Api-Ver",
  "X-Api-Sign",
  "X-Client",
  "X-Version",
];

// The real signer needs wasm (Workers only); this records what it was asked to sign.
function fakeSigner() {
  const signed: Array<{ method: string; path: string; params: Record<string, unknown> }> = [];
  const sign: SignRequest = (method, path, params) => {
    signed.push({ method, path, params });
    return Effect.succeed(Object.fromEntries(SIGNATURE_HEADERS.map((h) => [h, `${h}-value`])));
  };
  return { sign, signed };
}

function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes("chain/list")) return json(chains);
    if (path.includes("complex_protocol")) return json(protocols);
    if (path.includes("cache_token_list")) return json(tokens);
    return json({ total_usd_value: 1 }); // total_balance
  });
}

// The chain map is cached per base at module level; a fresh base gives a cold cache.
let bases = 0;
const freshBase = () => ({ RABBY_API_BASE: `https://rabby-${bases++}.test` });

type Ctx = Parameters<typeof rabbyBalance.fetchBalances>[0];
const ctx = (providerCreds: Record<string, string> = freshBase(), address = ADDR): Ctx =>
  ({
    account: { id: "a1", label: "EVM", connectorId: "evm", creds: { address } },
    creds: providerCreds,
  }) as unknown as Ctx;

// The gate spaces requests, so the virtual clock must move or the second request waits forever.
const drive = <A, E>(effect: Effect.Effect<A, E, UpstreamNeeds>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let i = 0; i < 20; i++) {
      yield* Effect.repeat(Effect.yieldNow, { times: 20 });
      yield* TestClock.adjust(Duration.seconds(1));
    }
    return yield* Fiber.join(fiber);
  });

const run = <A, E>(
  stub: HttpStub,
  effect: Effect.Effect<A, E, UpstreamNeeds>,
  sign: SignRequest = fakeSigner().sign,
) => runClient(stub, drive(effect.pipe(Effect.provideService(RabbySigner, sign))));
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
  sign: SignRequest = fakeSigner().sign,
): Promise<UpstreamError> => run(stub, Effect.flip(effect), sign);

describe("fetchBalances", () => {
  it("cold start: chain map first (both parsers need it), then tokens, then protocols", async () => {
    const stub = upstream();
    const { balances } = await run(stub, rabbyBalance.fetchBalances(ctx()));

    expect(balances.some((b) => b.kind === "spot")).toBe(true);
    expect(balances.some((b) => b.kind === "defi")).toBe(true);
    expect(stub.calls.map((c) => c.request.url.pathname)).toEqual([
      "/v1/chain/list",
      "/v1/user/cache_token_list",
      "/v1/user/complex_protocol_list",
    ]);
  });

  it("chain map cached: the next account costs two requests", async () => {
    const base = freshBase();
    const stub = upstream();
    await run(stub, rabbyBalance.fetchBalances(ctx(base)));
    await run(stub, rabbyBalance.fetchBalances(ctx(base, `0x${"1".repeat(40)}`)));
    expect(stub.calls).toHaveLength(5);
  });

  it("concurrent accounts on a cold cache fetch the chain map once", async () => {
    const base = freshBase();
    const stub = upstream();
    await run(
      stub,
      Effect.all(
        [1, 2, 3].map(() => rabbyBalance.fetchBalances(ctx(base))),
        {
          concurrency: "unbounded",
        },
      ),
    );
    expect(stub.calls.filter((c) => c.request.url.pathname === "/v1/chain/list")).toHaveLength(1);
  });

  it("refresh fails but an old map exists: uses the old one", async () => {
    const base = freshBase();
    let dead = false;
    const stub = upstream({
      "chain/list": () => (dead ? json({}, { status: 503 }) : json(chains)),
    });
    await run(stub, rabbyBalance.fetchBalances(ctx(base)));
    dead = true;
    const { balances } = await run(
      stub,
      Effect.andThen(TestClock.adjust(Duration.hours(25)), rabbyBalance.fetchBalances(ctx(base))),
    );
    expect(balances.length).toBeGreaterThan(0);
  });

  it("an empty chain list is a hard failure, never the slug fallback form", async () => {
    const stub = upstream({ "chain/list": () => json([]) });
    const err = await failing(stub, rabbyBalance.fetchBalances(ctx()));
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe("rabby");
  });

  it("without an override goes to the official host; with one, only there", async () => {
    expect(rabbyBalance.creds.map((f) => f.key)).toEqual(["RABBY_API_BASE"]);
    expect(rabbyBalance.creds.every((f) => f.type === "public")).toBe(true);

    const stub = upstream();
    await run(stub, rabbyBalance.fetchBalances(ctx({})));
    await run(
      stub,
      rabbyBalance.fetchBalances(ctx({ RABBY_API_BASE: "http://127.0.0.1:3399/rabby" })),
    );
    const hosts = stub.calls.map((c) => c.request.url.href);
    expect(hosts[0].startsWith("https://api.rabby.io/v1/")).toBe(true);
    expect(hosts.at(-1)?.startsWith("http://127.0.0.1:3399/rabby/v1/")).toBe(true);
  });
});

describe("signing", () => {
  it("signs exactly the query that is sent", async () => {
    const stub = upstream();
    const signer = fakeSigner();
    await run(stub, rabbyBalance.fetchBalances(ctx()), signer.sign);

    expect(signer.signed[0]).toEqual({ method: "GET", path: "/v1/chain/list", params: {} });
    expect(signer.signed[1]).toEqual({
      method: "GET",
      path: "/v1/user/cache_token_list",
      params: { id: ADDR },
    });
    const sent = stub.calls[1].request.url;
    expect([...sent.searchParams.entries()]).toEqual([["id", ADDR]]);
  });

  it("sends all six signature headers (one missing drops to the one-per-40s tier)", async () => {
    const stub = upstream();
    await run(stub, rabbyBalance.fetchBalances(ctx()));
    const headers = stub.calls[0].request.headers;
    for (const key of SIGNATURE_HEADERS) expect(headers[key]).toBeTruthy();
    expect(headers.accept).toBe("application/json");
  });

  it("a signing failure is a credentials problem and sends nothing", async () => {
    const stub = upstream();
    const boom: SignRequest = (_m, path) => Effect.fail(new SigningFailure({ where: path }));
    const err = await failing(stub, rabbyBalance.fetchBalances(ctx()), boom);
    expect(err._tag).toBe("UpstreamAuthError");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("rate gate: one at a time, 8/s", () => {
  // A cold fetch sends three requests in a row: at 0, 125 and 250 ms.
  const settledAfter = (ms: number) =>
    runClient(
      upstream(),
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.orDie(rabbyBalance.fetchBalances(ctx())));
        yield* TestClock.adjust(Duration.millis(ms));
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        return (yield* Effect.sync(() => fiber.pollUnsafe())) !== undefined;
      }).pipe(Effect.provideService(RabbySigner, fakeSigner().sign)),
    );

  it("each request waits one spacing (no burst)", async () => {
    expect(await settledAfter(249)).toBe(false);
    expect(await settledAfter(250)).toBe(true);
  });
});

describe("failure classification", () => {
  it("429 gives rate-limited, without Retry-After", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    const err = await failing(stub, rabbyBalance.fetchBalances(ctx()));
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBeUndefined();
  });

  it("errors carry no query / address", async () => {
    const stub = upstream({ cache_token_list: () => json({}, { status: 503 }) });
    const err = await failing(stub, rabbyBalance.fetchBalances(ctx()));
    expect(err.where).toBe("/v1/user/cache_token_list");
    expect(JSON.stringify(err)).not.toContain(ADDR);
  });
});

describe("validateAccount", () => {
  it("200 gives true, from the lightest total_balance", async () => {
    const stub = httpStub(() => json({ total_usd_value: 1 }));
    expect(await run(stub, rabbyBalance.validateAccount(ctx()))).toBe(true);
    expect(stub.calls[0].request.url.pathname).toBe("/v1/user/total_balance");
  });

  it("credentials rejected (403): false", async () => {
    const stub = httpStub(() => json({}, { status: 403 }));
    expect(await run(stub, rabbyBalance.validateAccount(ctx()))).toBe(false);
  });
});
