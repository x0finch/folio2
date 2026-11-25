import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { hyperliquidBalance } from "../../../src/balance/hyperliquid/upstream";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../../src/runtime/testing";
import fixture from "./fixtures/clearinghouse-state.json";
import neverTraded from "./fixtures/clearinghouse-state-empty.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

type Ctx = Parameters<typeof hyperliquidBalance.fetchBalances>[0];
const ctx = (address = ADDR, providerCreds: Record<string, string> = {}): Ctx =>
  ({
    account: { id: "a1", label: "HL", connectorId: "hyperliquid", creds: { address } },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  it("POST /info with type and user in the body, as JSON, then parses", async () => {
    const stub = httpStub(() => json(fixture));
    const { balances } = await run(stub, hyperliquidBalance.fetchBalances(ctx()));

    expect(balances.some((b) => b.kind === "perp_equity")).toBe(true);
    const sent = stub.calls[0].request;
    expect(sent.url.href).toBe("https://api.hyperliquid.xyz/info");
    expect(sent.method).toBe("POST");
    expect(JSON.parse(String(sent.body))).toEqual({ type: "clearinghouseState", user: ADDR });
    // Upstream answers 422 without it.
    expect(sent.headers["content-type"]).toBe("application/json");
  });

  it("no gate: 20 accounts back to back produce no waiting", async () => {
    // A virtual clock still at 0 means nothing ever waited, independent of scheduling speed.
    const stub = httpStub(() => json(fixture));
    const elapsed = await runClient(
      stub,
      Effect.gen(function* () {
        yield* Effect.all(
          Array.from({ length: 20 }, (_, i) =>
            Effect.orDie(hyperliquidBalance.fetchBalances(ctx(`0x${String(i).padStart(40, "0")}`))),
          ),
          { concurrency: "unbounded" },
        );
        return yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      }),
    );
    expect(elapsed).toBe(0);
    expect(stub.calls).toHaveLength(20);
  });
});

describe("failure classification", () => {
  it("errors name the upstream and carry no address", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, hyperliquidBalance.fetchBalances(ctx()));
    expect(err.upstream).toBe("hyperliquid");
    expect(err.where).toBe("/info");
    expect(JSON.stringify(err)).not.toContain(ADDR);
  });
});

describe("base override", () => {
  it("a set base hits the override, an unset one goes direct to the official host", async () => {
    const overrides = { HYPERLIQUID_API_BASE: "http://127.0.0.1:3399/hyperliquid" };
    expect(hyperliquidBalance.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(hyperliquidBalance.creds.every((f) => f.type === "public")).toBe(true);

    const stub = httpStub(() => json(fixture));
    await run(stub, hyperliquidBalance.fetchBalances(ctx(ADDR, overrides)));
    await run(stub, hyperliquidBalance.fetchBalances(ctx()));
    expect(stub.calls.map((c) => c.request.url.href)).toEqual([
      "http://127.0.0.1:3399/hyperliquid/info",
      "https://api.hyperliquid.xyz/info",
    ]);
  });
});

describe("validateAccount", () => {
  it("200 gives true (an address that never traded is also 200 + empty state)", async () => {
    const stub = httpStub(() => json(neverTraded));
    expect(await run(stub, hyperliquidBalance.validateAccount(ctx()))).toBe(true);
  });
});
