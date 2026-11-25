import { isRetryable, type UpstreamError, type UpstreamNeeds } from "@folio/upstream-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { okxBalance } from "../../../src/balance/okx/upstream";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../../src/runtime/testing";
import balance from "./fixtures/balance.json";
import funding from "./fixtures/funding.json";
import savings from "./fixtures/savings.json";
import staking from "./fixtures/staking.json";
import valuation from "./fixtures/valuation.json";

const CREDS = { apiKey: "the-key", secret: "the-secret", passphrase: "the-phrase" };
// Under TestClock the clock starts at 0, so the signing string is deterministic.
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

// An independent reference: what is checked is which string was signed.
async function hmacB64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return btoa(String.fromCharCode(...sig));
}

const empty = () => json({ code: "0", data: [] });

// Routes by pathname; unmatched paths answer as the trading account.
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
    return json(balance);
  });
}

type Ctx = Parameters<typeof okxBalance.fetchBalances>[0];
const ctx = (providerCreds: Record<string, string> = {}): Ctx =>
  ({
    account: { id: "a1", label: "OKX", connectorId: "okx", creds: CREDS },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

const sentTo = (stub: HttpStub, fragment: string) =>
  stub.calls.find((c) => c.request.url.pathname.includes(fragment))?.request;

describe("signing", () => {
  it("signs ISO timestamp + GET + requestPath, base64, with all four OK-ACCESS headers", async () => {
    const stub = upstream();
    await run(stub, okxBalance.validateAccount(ctx()));
    const h = stub.calls[0].request.headers;
    expect(h["OK-ACCESS-TIMESTAMP"]).toBe(EPOCH_ISO);
    expect(h["OK-ACCESS-SIGN"]).toBe(
      await hmacB64(CREDS.secret, `${EPOCH_ISO}GET/api/v5/account/balance`),
    );
    expect(h["OK-ACCESS-KEY"]).toBe(CREDS.apiKey);
    expect(h["OK-ACCESS-PASSPHRASE"]).toBe(CREDS.passphrase);
  });

  it("requestPath includes the query (without it OKX answers 50113); valuation asks for USD", async () => {
    const stub = upstream();
    await run(stub, okxBalance.fetchBalances(ctx()));
    const sent = sentTo(stub, "asset-valuation");
    expect(sent?.url.searchParams.get("ccy")).toBe("USD");
    expect(sent?.headers["OK-ACCESS-SIGN"]).toBe(
      await hmacB64(CREDS.secret, `${EPOCH_ISO}GET/api/v5/asset/asset-valuation?ccy=USD`),
    );
  });

  it("secret and passphrase never go in the URL", async () => {
    const stub = upstream();
    await run(stub, okxBalance.fetchBalances(ctx()));
    for (const { request } of stub.calls) {
      expect(request.url.href).not.toContain(CREDS.secret);
      expect(request.url.href).not.toContain(CREDS.passphrase);
    }
  });
});

describe("fetchBalances", () => {
  it("all buckets: trading / funding / earn merged, plus the unitemised earn row", async () => {
    const stub = upstream();
    const { balances, note } = await run(stub, okxBalance.fetchBalances(ctx()));

    expect(balances).toHaveLength(10); // trading 4 + funding 3 + earn 2 + earn residual 1
    const uncategorized = balances.find((b) => b.tokenRef === "okx/custom:EARN-UNCATEGORIZED");
    expect(uncategorized).toMatchObject({ value: 1000, kind: "spot" });
    expect(balances.filter((b) => b.note?.group === "earn")).toHaveLength(3);
    expect(note).toBeUndefined();
    expect(stub.calls.every((c) => c.request.url.origin === "https://www.okx.com")).toBe(true);
  });

  it("asset-valuation down: no residual this round, nothing else lost", async () => {
    const stub = upstream({ "/asset/asset-valuation": () => json({}, { status: 500 }) });
    const { balances, note } = await run(stub, okxBalance.fetchBalances(ctx()));
    expect(balances).toHaveLength(9);
    expect(note).toBeUndefined();
  });

  it("earn lacks permission: the rest + a note; no residual row for earn that wasn't read", async () => {
    const stub = upstream({
      "/finance/savings/balance": () => json({}, { status: 401 }),
      "/finance/staking-defi/orders-active": () => json({}, { status: 401 }),
      "/asset/asset-valuation": () => json({ code: "0", data: [{ details: { earn: "12000" } }] }),
    });
    const { balances, note } = await run(stub, okxBalance.fetchBalances(ctx()));

    expect(balances).toHaveLength(7); // trading 4 + funding 3
    expect(balances.some((b) => b.note?.group === "earn")).toBe(false);
    expect(note?.find((n) => n.title === "Buckets not synced")?.content).toBe(
      "Savings / Staking — check the API key's permissions",
    );
  });

  it("a transient bucket failure fails the whole account into retry", async () => {
    const stub = upstream({ "/account/balance": () => json({}, { status: 504 }) });
    expect(isRetryable(await failing(stub, okxBalance.fetchBalances(ctx())))).toBe(true);
  });

  it("an error code in a 200 is a failure: auth codes name the bucket in the note", async () => {
    const stub = upstream({
      "/api/v5/asset/balances": () => json({ code: "50111", msg: "Invalid Key" }),
    });
    const { note } = await run(stub, okxBalance.fetchBalances(ctx()));
    expect(note?.find((n) => n.title === "Buckets not synced")?.content).toBe(
      "Funding — check the API key's permissions",
    );
  });

  it("every bucket rate-limited: fails, never an empty snapshot", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, okxBalance.fetchBalances(ctx())))._tag).toBe(
      "UpstreamRateLimitError",
    );
  });

  it("open positions get the futures note; closed rows (pos 0) don't", async () => {
    const withPos = (pos: string) =>
      upstream({
        "/api/v5/account/positions": () =>
          json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", pos, upl: "1" }] }),
      });
    const open = await run(withPos("1"), okxBalance.fetchBalances(ctx()));
    expect(open.note?.some((n) => n.title === "Futures positions detected")).toBe(true);
    const closed = await run(withPos("0"), okxBalance.fetchBalances(ctx()));
    expect(closed.note?.some((n) => n.title === "Futures positions detected")).toBeFalsy();
  });

  it("a non-zero classic bucket (not synced) gets a note", async () => {
    const stub = upstream({
      "/asset/asset-valuation": () =>
        json({ code: "0", data: [{ details: { classic: "8888", earn: "0" } }] }),
    });
    const { note } = await run(stub, okxBalance.fetchBalances(ctx()));
    expect(note?.find((n) => n.title === "Classic account not synced")?.content).toContain(
      "$8,888",
    );
  });

  it("the base override replaces the host; it is the only env name, public", async () => {
    const overrides = { OKX_API_BASE: "https://px.example/okx" };
    expect(okxBalance.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(okxBalance.creds.every((f) => f.type === "public")).toBe(true);

    const stub = upstream();
    await run(stub, okxBalance.fetchBalances(ctx(overrides)));
    const urls = stub.calls.map((c) => c.request.url.href);
    expect(urls.every((u) => u.startsWith("https://px.example/okx/api/v5/"))).toBe(true);
    // The signature covers the API path, not the proxy prefix.
    expect(sentTo(stub, "/account/balance")?.headers["OK-ACCESS-SIGN"]).toBe(
      await hmacB64(CREDS.secret, `${EPOCH_ISO}GET/api/v5/account/balance`),
    );
  });
});

describe("failure classification", () => {
  const failWith = (reply: () => Response) =>
    failing(httpStub(reply), okxBalance.validateAccount(ctx()));

  it("auth codes in a 200 are auth; other codes are the upstream's fault", async () => {
    for (const code of ["50100", "50102", "50105", "50111", "50113"]) {
      const err = await failing(
        httpStub(() => json({ code, msg: "boom" })),
        okxBalance.fetchBalances(ctx()),
      );
      expect(err._tag).toBe("UpstreamAuthError");
    }
    expect((await failWith(() => json({ code: "51000", msg: "boom" })))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("the code and msg go into cause, not posing as an HTTP status", async () => {
    const err = await failWith(() => json({ code: "50011", msg: "Too Many" }));
    expect(err.status).toBeUndefined();
    expect(String(err.cause)).toBe("okx code 50011: Too Many");
  });

  it("a bare null body is a parse failure, not a crash", async () => {
    expect((await failWith(() => json(null)))._tag).toBe("UpstreamParseError");
  });
});

describe("validateAccount", () => {
  it("200 + code 0 → true; rejected credentials (200 + 50111) → false", async () => {
    expect(
      await run(
        httpStub(() => json(balance)),
        okxBalance.validateAccount(ctx()),
      ),
    ).toBe(true);
    const denied = httpStub(() => json({ code: "50111", msg: "Invalid Key" }));
    expect(await run(denied, okxBalance.validateAccount(ctx()))).toBe(false);
  });
});
