import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import { type ConnectorError, isRetryable, type ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { hyperliquidProvider } from "../../../src/connectors/hyperliquid/provider";
import fixture from "./fixtures/clearinghouse-state.json";
import neverTraded from "./fixtures/clearinghouse-state-empty.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

type Ctx = Parameters<typeof hyperliquidProvider.fetchBalances>[0];
const ctx = (address = ADDR, providerCreds: Record<string, string> = {}): Ctx =>
  ({
    account: { id: "a1", label: "HL", connectorId: "hyperliquid", creds: { address } },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  it("POST /info, with type and user in the body, then parses", async () => {
    const stub = httpStub(() => json(fixture));
    const { balances } = await run(stub, hyperliquidProvider.fetchBalances(ctx()));

    expect(balances.some((b) => b.kind === "perp_equity")).toBe(true);
    const sent = stub.calls[0].request;
    expect(sent.method).toBe("POST");
    expect(JSON.parse(String(sent.body))).toEqual({ type: "clearinghouseState", user: ADDR });
  });

  it("no gate: 20 accounts back to back produce no waiting", async () => {
    // This upstream is queried by address, one request per account; a gate would block nothing and queue unrelated accounts.
    // The criterion is how far the virtual clock moved: 0ms means nothing ever waited, independent of scheduling speed.
    const stub = httpStub(() => json(fixture));
    const elapsed = await runClient(
      stub,
      Effect.gen(function* () {
        yield* Effect.all(
          Array.from({ length: 20 }, (_, i) =>
            Effect.orDie(
              hyperliquidProvider.fetchBalances(ctx(`0x${String(i).padStart(40, "0")}`)),
            ),
          ),
          { concurrency: "unbounded" },
        );
        return yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      }),
    );
    expect(elapsed).toBe(0);
    expect(stub.calls).toHaveLength(20);
  });

  it("5xx gives unreachable (retryable)", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, hyperliquidProvider.fetchBalances(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });

  it("429 gives rate-limited (retryable)", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    const err = await failing(stub, hyperliquidProvider.fetchBalances(ctx()));
    expect(err._tag).toBe("ConnectorRateLimitError");
  });
});

describe("base override", () => {
  it("a set base hits the override, an unset one goes direct to the official host", async () => {
    const overrides = { HYPERLIQUID_API_BASE: "http://127.0.0.1:3399/hyperliquid" };
    // The declared key is the one that really takes effect when injected here (the app injects ctx.creds from env per the declaration); all public (not encrypted / exported).
    expect(hyperliquidProvider.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(hyperliquidProvider.creds.every((f) => f.type === "public")).toBe(true);

    const stub = httpStub(() => json(fixture));
    await run(stub, hyperliquidProvider.fetchBalances(ctx(ADDR, overrides)));
    await run(stub, hyperliquidProvider.fetchBalances(ctx()));
    expect(stub.calls.map((c) => c.request.url.href)).toEqual([
      "http://127.0.0.1:3399/hyperliquid/info",
      "https://api.hyperliquid.xyz/info",
    ]);
  });
});

describe("validateAccount", () => {
  it("200 gives true (an address that never traded is also 200 + empty state)", async () => {
    // Recorded for real: an address that never traded (0x…01) also answers 200: assetPositions empty, only a little stray equity sent in by others.
    const stub = httpStub(() => json(neverTraded));
    expect(await run(stub, hyperliquidProvider.validateAccount(ctx()))).toBe(true);
  });

  it("unreachable goes through the error channel, not squashed into false", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, hyperliquidProvider.validateAccount(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
  });
});
