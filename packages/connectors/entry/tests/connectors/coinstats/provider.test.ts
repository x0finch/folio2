import { validateCredentials } from "@folio/connectors-basic";
import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { type HttpStub, httpStub, runClient } from "@folio/upstreams/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  coinstatsAccountCreds,
  createCoinstatsProvider,
} from "../../../src/connectors/coinstats/provider";
import solana from "./fixtures/solana.json";

const ADDR = "So11111111111111111111111111111111111111112";
const KEY = "cs-key";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

type Ctx = Parameters<ReturnType<typeof createCoinstatsProvider>["fetchBalances"]>[0];
const ctx = (providerCreds: Record<string, string> = { COINSTATS_API_KEY: KEY }): Ctx =>
  ({
    account: { id: "a1", label: "Wallet", connectorId: "solana", creds: { address: ADDR } },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

describe("factory: one adapter service for three chains", () => {
  it("base override takes effect, no default host left; unset goes to the official host", async () => {
    const overrides = {
      COINSTATS_API_KEY: KEY,
      COINSTATS_API_BASE: "http://127.0.0.1:3399/coinstats",
    };
    const provider = createCoinstatsProvider("solana");
    // The declared keys are the two that really take effect when injected here (the app injects ctx.creds from env per the declaration); the base override is public.
    expect(provider.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(provider.creds.find((f) => f.key === "COINSTATS_API_BASE")?.type).toBe("public");

    const stub = httpStub(() => json(solana));
    await run(stub, provider.fetchBalances(ctx(overrides)));
    await run(stub, provider.fetchBalances(ctx()));
    const [overridden, plain] = stub.calls.map((c) => c.request.url.href);
    expect(overridden.startsWith("http://127.0.0.1:3399/coinstats/wallet/balance")).toBe(true);
    expect(plain.startsWith("https://openapiv1.coinstats.app/")).toBe(true);
  });

  it("connectionId binds each chain (sui to 'sui-wallet')", async () => {
    const stub = httpStub(() => json([]));
    await run(stub, createCoinstatsProvider("sui-wallet").fetchBalances(ctx()));
    expect(stub.calls[0].request.url.searchParams.get("connectionId")).toBe("sui-wallet");
  });
});

describe("fetchBalances", () => {
  it("sends X-API-KEY and parses balances", async () => {
    const stub = httpStub(() => json(solana));
    const { balances } = await run(stub, createCoinstatsProvider("solana").fetchBalances(ctx()));

    expect(balances.length).toBeGreaterThan(0);
    expect(stub.calls[0].request.headers["x-api-key"]).toBe(KEY);
    expect(stub.calls[0].request.url.searchParams.get("address")).toBe(ADDR);
  });

  it("no provider key configured: a credentials problem, and no request at all", async () => {
    const stub = httpStub(() => json([]));
    const err = await failing(stub, createCoinstatsProvider("solana").fetchBalances(ctx({})));
    expect(err._tag).toBe("UpstreamAuthError");
    expect(stub.calls).toHaveLength(0);
  });

  it("429 gives rate-limited; 401 gives a credentials problem", async () => {
    const limited = httpStub(() => json({}, { status: 429 }));
    expect(
      (await failing(limited, createCoinstatsProvider("solana").fetchBalances(ctx())))._tag,
    ).toBe("UpstreamRateLimitError");
    const denied = httpStub(() => json({}, { status: 401 }));
    expect(
      (await failing(denied, createCoinstatsProvider("solana").fetchBalances(ctx())))._tag,
    ).toBe("UpstreamAuthError");
  });
});

describe("validateAccount", () => {
  it("no key configured: false, and no request at all", async () => {
    // The old version had an `if (!apiKey) return false` precheck for this. A missing key now reports a credentials problem,
    // which this path already answers with `false`, so the same thing need not be written twice.
    const stub = httpStub(() => json([]));
    expect(await run(stub, createCoinstatsProvider("solana").validateAccount(ctx({})))).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("200 → true;401 → false", async () => {
    const ok = httpStub(() => json([]));
    expect(await run(ok, createCoinstatsProvider("solana").validateAccount(ctx()))).toBe(true);
    const denied = httpStub(() => json({}, { status: 401 }));
    expect(await run(denied, createCoinstatsProvider("solana").validateAccount(ctx()))).toBe(false);
  });

  it("unreachable goes through the error channel, not squashed into false", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    expect(
      (await failing(stub, createCoinstatsProvider("solana").validateAccount(ctx())))._tag,
    ).toBe("UpstreamUnavailableError");
  });
});

// account.creds validation gate (runs before the app's dispatch bridge fetches; the three chains share this declaration, format left to the API so only non-empty).
describe("account.creds validation gate", () => {
  it("accepts a non-empty address (after trim)", async () => {
    await expect(validateCredentials(coinstatsAccountCreds, { address: ADDR })).resolves.toEqual({
      address: ADDR,
    });
  });

  it("rejects an empty / missing address (a fast non-retryable failure in the bridge)", async () => {
    await expect(validateCredentials(coinstatsAccountCreds, { address: "  " })).rejects.toThrow(
      /address/,
    );
    await expect(validateCredentials(coinstatsAccountCreds, {})).rejects.toThrow(/address/);
  });
});
