import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import { type ConnectorError, isRetryable, type ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { okxProvider } from "../../../src/connectors/okx/provider";
import balance from "./fixtures/balance.json";
import funding from "./fixtures/funding.json";
import savings from "./fixtures/savings.json";
import staking from "./fixtures/staking.json";
import valuation from "./fixtures/valuation.json";

// Stubs the `HttpClient` service, not `globalThis.fetch`, which is the path production takes.
const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const empty = () => json({ code: "0", data: [] });

// Dispatch by pathname. Buckets not given default to empty and unmatched ones fall to the trading account: each case writes only what it cares about.
function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes("/api/v5/asset/balances")) return json(funding);
    if (path.includes("/finance/savings/balance")) return json(savings);
    if (path.includes("/finance/staking-defi/orders-active")) return json(staking);
    if (path.includes("/asset/asset-valuation")) return json(valuation);
    if (path.includes("/api/v5/account/positions")) return empty();
    return json(balance); // /api/v5/account/balance
  });
}

type Ctx = Parameters<typeof okxProvider.fetchBalances>[0];
const CREDS = { apiKey: "k", secret: "s", passphrase: "p" };
const ctx = (creds: Record<string, string> = CREDS, providerCreds: Record<string, string> = {}) =>
  ({
    account: { id: "a1", label: "OKX", connectorId: "okx", creds },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  it("all buckets concurrently (trading / funding / earn): merged into spot; the earn residual synthetic row counts into net worth", async () => {
    const stub = upstream();
    const { balances, note } = await run(stub, okxProvider.fetchBalances(ctx()));

    expect(balances).toHaveLength(10); // trading 4 + funding 3 + earn 2 + earn residual synthetic row 1
    const uncategorized = balances.find((b) => b.tokenRef === "okx/custom:EARN-UNCATEGORIZED");
    expect(uncategorized).toMatchObject({ value: 1000, kind: "spot" });
    expect(uncategorized?.note?.group).toBe("earn");
    expect(balances.filter((b) => b.note?.group === "earn")).toHaveLength(3);
    expect(note).toBeUndefined();
  });

  it("all four OK-ACCESS headers are sent, and spot parsing matches", async () => {
    const stub = upstream({ "/api/v5/asset/balances": empty });
    const { balances } = await run(stub, okxProvider.fetchBalances(ctx()));

    expect(balances.map((b) => b.symbol)).toContain("BTC");
    const headers = stub.calls[0].request.headers;
    expect(headers["ok-access-key"]).toBe("k");
    expect(headers["ok-access-sign"]).toBeTruthy();
    expect(headers["ok-access-timestamp"]).toBeTruthy();
    expect(headers["ok-access-passphrase"]).toBe("p");
  });

  it("asset-valuation down: does not block sync, there is just no residual this round", async () => {
    const stub = upstream({ "/asset/asset-valuation": () => json({}, { status: 500 }) });
    const { balances, note } = await run(stub, okxProvider.fetchBalances(ctx()));
    expect(balances).toHaveLength(9);
    expect(note).toBeUndefined();
  });

  it("a partial bucket failure (earn lacks permission): the rest are returned + an account-level Note; the whole sync succeeds", async () => {
    // 401 rather than 504: a transient fault now escalates to whole-account failure (next case) and never reaches the Note.
    // Best effort is only for failures where "waiting does not help": a permission not granted cannot be fixed by retrying.
    const stub = upstream({
      "/finance/savings/balance": () => json({}, { status: 401 }),
      "/finance/staking-defi/orders-active": () => json({}, { status: 401 }),
      "/asset/asset-valuation": () => json({ code: "0", data: [{ details: { earn: "12000" } }] }),
    });
    const { balances, note } = await run(stub, okxProvider.fetchBalances(ctx()));

    expect(balances).toHaveLength(7); // trading 4 + funding 3
    expect(balances.some((b) => b.note?.group === "earn")).toBe(false);
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Savings");
    expect(String(failNote?.content)).toContain("Staking");
    expect(String(failNote?.content)).toContain("permissions");
    // When the earn bucket fails no uncategorised synthetic row is produced: that $12k was not fetched, not uncategorised, and counting it would inflate net worth.
    expect(balances.some((b) => b.tokenRef === "okx/custom:EARN-UNCATEGORIZED")).toBe(false);
  });

  // A transient partial failure escalates
  it("a transient partial bucket failure (trading bucket 504): the whole account fails into retry, no partial snapshot written", async () => {
    // The trading bucket is usually the bulk; degrading would drop a chunk of assets, the same symptom as the binance production incident.
    const stub = upstream({ "/account/balance": () => json({}, { status: 504 }) });
    const err = await failing(stub, okxProvider.fetchBalances(ctx()));
    expect(isRetryable(err)).toBe(true);
  });

  it("transient mixed with permission errors: still whole-account failure (the transient one is the reason to retry)", async () => {
    const stub = upstream({
      "/finance/savings/balance": () => json({}, { status: 401 }),
      "/asset/balances": () => json({}, { status: 429 }),
    });
    const err = await failing(stub, okxProvider.fetchBalances(ctx()));
    expect(isRetryable(err)).toBe(true);
  });

  it("an auth-class failure (HTTP 200 + 50xxx): a failure Note prompting a permissions check", async () => {
    const stub = upstream({
      "/api/v5/asset/balances": () => json({ code: "50111", msg: "Invalid Key" }),
      "/finance/": empty,
      "/asset/asset-valuation": empty,
    });
    const { note } = await run(stub, okxProvider.fetchBalances(ctx()));
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Funding");
    expect(String(failNote?.content)).toContain("permissions");
  });

  it("all four balance buckets fail (429 on every endpoint): failure, no empty snapshot overwriting", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, okxProvider.fetchBalances(ctx())))._tag).toBe(
      "ConnectorRateLimitError",
    );
  });

  it("positions non-empty: attaches the fallback Note about contract unrealised profit not yet included", async () => {
    const stub = upstream({
      "/api/v5/account/positions": () =>
        json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", pos: "1", upl: "123" }] }),
      "/api/v5/asset/balances": empty,
      "/finance/": empty,
      "/asset/asset-valuation": empty,
    });
    const { note } = await run(stub, okxProvider.fetchBalances(ctx()));
    expect(note?.some((n) => n.title === "Futures positions detected")).toBe(true);
  });

  it("positions all closed rows (pos=0): no false report", async () => {
    const stub = upstream({
      "/api/v5/account/positions": () =>
        json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", pos: "0", upl: "0" }] }),
      "/api/v5/asset/balances": empty,
      "/finance/": empty,
      "/asset/asset-valuation": empty,
    });
    const { note } = await run(stub, okxProvider.fetchBalances(ctx()));
    expect(note?.some((n) => n.title === "Futures positions detected")).toBeFalsy();
  });

  it("four-bucket reconciliation: classic bucket > 0 (folio does not fetch it): attaches a classic-account-not-synced Note", async () => {
    const stub = upstream({
      "/asset/asset-valuation": () =>
        json({ code: "0", data: [{ details: { classic: "8888", earn: "0" } }] }),
      "/api/v5/asset/balances": empty,
      "/finance/": empty,
    });
    const { note } = await run(stub, okxProvider.fetchBalances(ctx()));
    expect(String(note?.find((n) => n.title === "Classic account not synced")?.content)).toContain(
      "$8,888",
    );
  });

  it("asset-valuation must carry ccy=USD (the endpoint defaults to BTC pricing, so omitting it misaligns units)", async () => {
    const stub = upstream();
    await run(stub, okxProvider.fetchBalances(ctx()));
    const valuationCall = stub.calls.find((c) =>
      c.request.url.pathname.includes("asset-valuation"),
    );
    expect(valuationCall?.request.url.searchParams.get("ccy")).toBe("USD");
  });

  it("base override takes effect, no default host left", async () => {
    const overrides = { OKX_API_BASE: "https://px.example/okx" };
    // The declared key is the one that really takes effect when injected here (the app injects ctx.creds from env per the declaration); all public (not encrypted / exported).
    expect(okxProvider.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(okxProvider.creds.every((f) => f.type === "public")).toBe(true);

    const stub = upstream();
    await run(stub, okxProvider.fetchBalances(ctx(CREDS, overrides)));
    const urls = stub.calls.map((c) => c.request.url.href);
    expect(urls.every((u) => u.startsWith("https://px.example/okx"))).toBe(true);
    expect(urls.some((u) => u.includes("okx.com"))).toBe(false);
  });
});

describe("validateAccount", () => {
  it("200 + code 0 → true", async () => {
    const stub = httpStub(() => json(balance));
    expect(await run(stub, okxProvider.validateAccount(ctx()))).toBe(true);
  });

  it("credentials rejected (HTTP 200 + 50111): false, not through the error channel", async () => {
    const stub = httpStub(() => json({ code: "50111", msg: "Invalid Key" }));
    expect(await run(stub, okxProvider.validateAccount(ctx()))).toBe(false);
  });

  it("a non-credentials code goes through the error channel, not squashed into false", async () => {
    const stub = httpStub(() => json({ code: "50011", msg: "rate limited" }));
    const err = await failing(stub, okxProvider.validateAccount(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
  });

  it("429 gives rate-limited (retryable)", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, okxProvider.validateAccount(ctx())))._tag).toBe(
      "ConnectorRateLimitError",
    );
  });
});
