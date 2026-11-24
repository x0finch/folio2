import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import { RabbySigner, type SignRequest } from "@folio/rabby-client";
import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { rabbyProvider } from "../../../src/connectors/evm/rabby-provider";
import tokens from "./fixtures/rabby-cache-token-list.json";
import chains from "./fixtures/rabby-chain-list.json";
import protocols from "./fixtures/rabby-complex-protocol-list.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

// Fake signer: the real one needs wasm (runs only in Workers). What is verified is the wiring; the signature algorithm is not under test.
const fakeSign: SignRequest = () =>
  Effect.succeed({ "X-Api-Ts": "1", "X-Api-Nonce": "n", "X-Api-Sign": "sig" });

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

type Ctx = Parameters<typeof rabbyProvider.fetchBalances>[0];
const ctx = (address = ADDR, providerCreds: Record<string, string> = {}): Ctx =>
  ({
    account: { id: "a1", label: "EVM", connectorId: "evm", creds: { address } },
    creds: providerCreds,
  }) as unknown as Ctx;

// Rabby has a gate (limit=1), so with several requests the virtual clock must be advanced or the second waits forever:
// fork, repeatedly advance a bit + flush microtasks, join. The clock is virtual (no real time); microtasks are flushed because the fake
// egress uses `Promise.resolve`, which TestClock does not govern.
const drive = <A, E>(effect: Effect.Effect<A, E, UpstreamNeeds>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let i = 0; i < 20; i++) {
      yield* Effect.repeat(Effect.yieldNow, { times: 20 });
      yield* TestClock.adjust(Duration.seconds(1));
    }
    return yield* Fiber.join(fiber);
  });

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, drive(effect.pipe(Effect.provideService(RabbySigner, fakeSign))));
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> =>
  runClient(stub, drive(Effect.flip(effect).pipe(Effect.provideService(RabbySigner, fakeSign))));

describe("fetchBalances", () => {
  // The order within this describe is meaningful: the chain mapping is cached 24h in the client at module level (on CF Workers each request runs
  // one runPromise, so a Scope would reset it every request), so only the first case sees a cold cache. Rather than work around it, make it coverage:
  // the first pins the cold start's three requests and their order, the second pins "the second account costs only two", which is why the cache exists.
  it("cold start: three requests in a fixed order: the chain mapping first, since the other two parses need it", async () => {
    // The order is the only observable consequence of `Effect.all` running sequentially, and fully deterministic.
    // (Not counting "how many in flight": that needs a stub that really hangs, or add/subtract in one tick, always 1: a vacuous assertion.)
    const stub = upstream();
    const { balances } = await run(stub, rabbyProvider.fetchBalances(ctx()));

    expect(balances.some((b) => b.kind === "spot")).toBe(true);
    expect(balances.some((b) => b.kind === "defi")).toBe(true);

    const paths = stub.calls.map((c) => c.request.url.pathname);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain("chain/list");
    expect(paths[1]).toContain("cache_token_list");
    expect(paths[2]).toContain("complex_protocol");
  });

  it("chain mapping cached 24h: the next account costs only two requests, no second chain list", async () => {
    const stub = upstream();
    await run(stub, rabbyProvider.fetchBalances(ctx(`0x${"1".repeat(40)}`)));

    const paths = stub.calls.map((c) => c.request.url.pathname);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.includes("chain/list"))).toBe(false);
  });

  it("base override takes effect, no default host left", async () => {
    const overrides = { RABBY_API_BASE: "http://127.0.0.1:3399/rabby" };
    // No provider key: this is the only public base override (the reason it is the default source).
    // The declared key is the one that really takes effect when injected here (the app injects ctx.creds from env per the declaration); all public (not encrypted / exported).
    expect(rabbyProvider.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(rabbyProvider.creds.every((f) => f.type === "public")).toBe(true);

    const stub = upstream();
    await run(stub, rabbyProvider.fetchBalances(ctx(`0x${"2".repeat(40)}`, overrides)));
    const urls = stub.calls.map((c) => c.request.url.href);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:3399/rabby/v1/"))).toBe(true);
  });

  it("429 gives rate-limited (retryable)", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, rabbyProvider.fetchBalances(ctx())))._tag).toBe(
      "UpstreamRateLimitError",
    );
  });
});

describe("validateAccount", () => {
  it("200 gives true (hits the lightest total_balance)", async () => {
    const stub = httpStub(() => json({ total_usd_value: 1 }));
    expect(await run(stub, rabbyProvider.validateAccount(ctx()))).toBe(true);
    expect(stub.calls[0].request.url.pathname).toContain("total_balance");
  });

  it("credentials rejected (403): false", async () => {
    const stub = httpStub(() => json({}, { status: 403 }));
    expect(await run(stub, rabbyProvider.validateAccount(ctx()))).toBe(false);
  });

  it("5xx goes through the error channel, not squashed into false", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    expect((await failing(stub, rabbyProvider.validateAccount(ctx())))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });
});
