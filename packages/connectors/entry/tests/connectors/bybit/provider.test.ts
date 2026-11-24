import type { UpstreamNeeds } from "@folio/upstream-basic";
import { isRetryable, type UpstreamError } from "@folio/upstream-basic";
import { type HttpStub, httpStub, runClient } from "@folio/upstreams/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { bybitProvider } from "../../../src/connectors/bybit/provider";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnOnchain from "./fixtures/earn-onchain.json";
import funding from "./fixtures/funding.json";
import wallet from "./fixtures/wallet-balance.json";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const okEmpty = () => json({ retCode: 0, result: { list: [] } });

// Dispatch by pathname + query (the two earn categories share one path and differ by `category`).
function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const { pathname, searchParams } = request.url;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (fragment.startsWith("category=")) {
        if (searchParams.get("category") === fragment.slice("category=".length)) return reply();
      } else if (pathname.includes(fragment)) {
        return reply();
      }
    }
    if (pathname.includes("/v5/earn/position")) {
      return json(searchParams.get("category") === "OnChain" ? earnOnchain : earnFlexible);
    }
    if (pathname.includes("/query-account-coins-balance")) return json(funding);
    return json(wallet); // /v5/account/wallet-balance
  });
}

type Ctx = Parameters<typeof bybitProvider.fetchBalances>[0];
const CREDS = { apiKey: "k", secret: "s" };
const ctx = (creds: Record<string, string> = CREDS, providerCreds: Record<string, string> = {}) =>
  ({
    account: { id: "a1", label: "Bybit", connectorId: "bybit", creds },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  it("all buckets concurrently (unified / funding / earn): merged into spot; earn gets note.group by category", async () => {
    const stub = upstream();
    const { balances } = await run(stub, bybitProvider.fetchBalances(ctx()));

    expect(balances.length).toBeGreaterThan(0);
    expect(balances.some((b) => b.note?.group === "funding")).toBe(true);
    expect(balances.some((b) => b.note?.group === "earn")).toBe(true);
    // One request per each of the four buckets.
    expect(stub.calls).toHaveLength(4);
  });

  it("all X-BAPI signature headers are sent", async () => {
    const stub = upstream();
    await run(stub, bybitProvider.fetchBalances(ctx()));
    const headers = stub.calls[0].request.headers;
    expect(headers["x-bapi-api-key"]).toBe("k");
    expect(headers["x-bapi-sign"]).toBeTruthy();
    expect(headers["x-bapi-timestamp"]).toBeTruthy();
  });

  // A transient partial failure escalates
  it("a transient partial bucket failure (funding account 504): the whole account fails into retry, no partial snapshot written", async () => {
    // This used to return the rest + a Note, which was the source of assets dropping a chunk: a degraded partial snapshot overwrites
    // real assets while the next round could fetch them.
    const stub = upstream({ "/query-account-coins-balance": () => json({}, { status: 504 }) });
    const err = await failing(stub, bybitProvider.fetchBalances(ctx()));
    expect(isRetryable(err)).toBe(true);
  });

  it("transient mixed with permission errors: still whole-account failure (the transient one is the reason to retry)", async () => {
    const stub = upstream({
      "/query-account-coins-balance": () => json({ retCode: 10005, retMsg: "permission denied" }),
      "/earn/position": () => json({}, { status: 429 }),
    });
    const err = await failing(stub, bybitProvider.fetchBalances(ctx()));
    expect(isRetryable(err)).toBe(true);
  });

  it("an auth-class failure (HTTP 200 + retCode 10005): a failure Note prompting a permissions check", async () => {
    const stub = upstream({
      "/query-account-coins-balance": () => json({ retCode: 10005, retMsg: "permission denied" }),
    });
    const { note } = await run(stub, bybitProvider.fetchBalances(ctx()));
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Funding");
    expect(String(failNote?.content)).toContain("permissions");
  });

  it("all buckets fail (429 on every endpoint): failure, no empty snapshot overwriting", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, bybitProvider.fetchBalances(ctx())))._tag).toBe(
      "UpstreamRateLimitError",
    );
  });

  it("unified account totalPerpUPL non-zero: attaches the fallback Note about contract unrealised profit not yet included", async () => {
    const stub = upstream({
      "/v5/account/wallet-balance": () =>
        json({ retCode: 0, result: { list: [{ coin: [], totalPerpUPL: "123.45" }] } }),
      "/query-account-coins-balance": okEmpty,
      "/v5/earn/position": okEmpty,
    });
    const { note } = await run(stub, bybitProvider.fetchBalances(ctx()));
    expect(note?.some((n) => n.title === "Futures positions detected")).toBe(true);
  });

  it("no contract unrealised profit (totalPerpUPL missing / 0): no false report", async () => {
    const stub = upstream({
      "/v5/account/wallet-balance": () =>
        json({ retCode: 0, result: { list: [{ coin: [], totalPerpUPL: "0" }] } }),
      "/query-account-coins-balance": okEmpty,
      "/v5/earn/position": okEmpty,
    });
    const { note } = await run(stub, bybitProvider.fetchBalances(ctx()));
    expect(note?.some((n) => n.title === "Futures positions detected")).toBeFalsy();
  });

  it("base override takes effect, no default host left", async () => {
    const overrides = { BYBIT_API_BASE: "https://px.example/bybit" };
    // The declared key is the one that really takes effect when injected here (the app injects ctx.creds from env per the declaration); all public (not encrypted / exported).
    expect(bybitProvider.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(bybitProvider.creds.every((f) => f.type === "public")).toBe(true);

    const stub = upstream();
    await run(stub, bybitProvider.fetchBalances(ctx(CREDS, overrides)));
    const urls = stub.calls.map((c) => c.request.url.href);
    expect(urls.every((u) => u.startsWith("https://px.example/bybit"))).toBe(true);
    expect(urls.some((u) => u.includes("bybit.com"))).toBe(false);
  });
});

describe("validateAccount", () => {
  it("retCode 0 → true", async () => {
    const stub = httpStub(() => json(wallet));
    expect(await run(stub, bybitProvider.validateAccount(ctx()))).toBe(true);
  });

  it("credentials rejected (HTTP 200 + retCode 10003): false, not through the error channel", async () => {
    const stub = httpStub(() => json({ retCode: 10003, retMsg: "API key is invalid" }));
    expect(await run(stub, bybitProvider.validateAccount(ctx()))).toBe(false);
  });

  it("a non-credentials retCode goes through the error channel, not squashed into false", async () => {
    const stub = httpStub(() => json({ retCode: 10016, retMsg: "server error" }));
    expect((await failing(stub, bybitProvider.validateAccount(ctx())))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("429 gives rate-limited (retryable)", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, bybitProvider.validateAccount(ctx())))._tag).toBe(
      "UpstreamRateLimitError",
    );
  });
});
