import { isRetryable, type UpstreamError, type UpstreamNeeds } from "@folio/upstream-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { bybitBalance } from "../../../src/balance/bybit/upstream";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../../src/runtime/testing";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnOnchain from "./fixtures/earn-onchain.json";
import funding from "./fixtures/funding.json";
import wallet from "./fixtures/wallet-balance.json";

const CREDS = { apiKey: "the-key", secret: "the-secret" };

// An independent reference: what is checked is which string was signed.
async function hmacHex(secret: string, message: string): Promise<string> {
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
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const okEmpty = () => json({ retCode: 0, result: { list: [] } });

// Routes by pathname, or by `category=` for the two earn buckets that share one path.
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
    return json(wallet);
  });
}

type Ctx = Parameters<typeof bybitBalance.fetchBalances>[0];
const ctx = (providerCreds: Record<string, string> = {}): Ctx =>
  ({
    account: { id: "a1", label: "Bybit", connectorId: "bybit", creds: CREDS },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

describe("signing", () => {
  it("signs timestamp + apiKey + recvWindow + the query actually sent, hex", async () => {
    const stub = upstream();
    await run(stub, bybitBalance.validateAccount(ctx()));
    const { url, headers } = stub.calls[0].request;
    expect(url.searchParams.toString()).toBe("accountType=UNIFIED");
    // TestClock starts at 0.
    expect(headers["X-BAPI-TIMESTAMP"]).toBe("0");
    expect(headers["X-BAPI-SIGN"]).toBe(
      await hmacHex(CREDS.secret, `0${CREDS.apiKey}5000accountType=UNIFIED`),
    );
    expect(headers["X-BAPI-API-KEY"]).toBe(CREDS.apiKey);
    expect(headers["X-BAPI-RECV-WINDOW"]).toBe("5000");
    expect(headers["X-BAPI-SIGN-TYPE"]).toBe("2");
  });

  it("every bucket signs its own query; the secret is neither in the URL nor the headers", async () => {
    const stub = upstream();
    await run(stub, bybitBalance.fetchBalances(ctx()));
    for (const { request } of stub.calls) {
      const query = request.url.searchParams.toString();
      expect(request.headers["X-BAPI-SIGN"]).toBe(
        await hmacHex(CREDS.secret, `0${CREDS.apiKey}5000${query}`),
      );
      expect(request.url.href).not.toContain(CREDS.secret);
      expect(JSON.stringify(request.headers)).not.toContain(CREDS.secret);
    }
  });
});

describe("fetchBalances", () => {
  it("four buckets (unified / funding / two earn categories) merged into spot", async () => {
    const stub = upstream();
    const { balances, note } = await run(stub, bybitBalance.fetchBalances(ctx()));

    expect(stub.calls.map((c) => c.request.url.search).sort()).toEqual([
      "?accountType=FUND",
      "?accountType=UNIFIED",
      "?category=FlexibleSaving",
      "?category=OnChain",
    ]);
    expect(stub.calls.every((c) => c.request.url.origin === "https://api.bybit.com")).toBe(true);
    expect(balances.some((b) => b.note?.group === "funding")).toBe(true);
    expect(balances.filter((b) => b.note?.group === "earn").map((b) => b.note?.content)).toEqual(
      expect.arrayContaining(["Flexible", "On-chain"]),
    );
    expect(note).toBeUndefined();
  });

  it("a transient bucket failure fails the whole account into retry", async () => {
    const stub = upstream({ "/query-account-coins-balance": () => json({}, { status: 504 }) });
    expect(isRetryable(await failing(stub, bybitBalance.fetchBalances(ctx())))).toBe(true);
  });

  it("transient mixed with permission errors: still fails, with the transient one", async () => {
    const stub = upstream({
      "/query-account-coins-balance": () => json({ retCode: 10005, retMsg: "permission denied" }),
      "/earn/position": () => json({}, { status: 429 }),
    });
    expect(isRetryable(await failing(stub, bybitBalance.fetchBalances(ctx())))).toBe(true);
  });

  it("a permission code in a 200 names the bucket in the note; the rest still sync", async () => {
    const stub = upstream({
      "category=OnChain": () => json({ retCode: 10005, retMsg: "permission denied" }),
    });
    const { balances, note } = await run(stub, bybitBalance.fetchBalances(ctx()));
    expect(note?.find((n) => n.title === "Buckets not synced")?.content).toBe(
      "Earn (On-chain) — check the API key's permissions",
    );
    expect(balances.some((b) => b.note?.content === "Flexible")).toBe(true);
  });

  it("every bucket rate-limited: fails, never an empty snapshot", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, bybitBalance.fetchBalances(ctx())))._tag).toBe(
      "UpstreamRateLimitError",
    );
  });

  it("a non-zero totalPerpUPL gets the futures note; zero doesn't", async () => {
    const withUpl = (totalPerpUPL: string) =>
      upstream({
        "/v5/account/wallet-balance": () =>
          json({ retCode: 0, result: { list: [{ coin: [], totalPerpUPL }] } }),
        "/query-account-coins-balance": okEmpty,
        "/v5/earn/position": okEmpty,
      });
    const open = await run(withUpl("-123.456"), bybitBalance.fetchBalances(ctx()));
    expect(open.note?.find((n) => n.title === "Futures positions detected")?.content).toContain(
      "-$123.46",
    );
    const flat = await run(withUpl("0"), bybitBalance.fetchBalances(ctx()));
    expect(flat.note).toBeUndefined();
  });

  it("the base override replaces the host; it is the only env name, public", async () => {
    const overrides = { BYBIT_API_BASE: "https://px.example/bybit" };
    expect(bybitBalance.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(bybitBalance.creds.every((f) => f.type === "public")).toBe(true);

    const stub = upstream();
    await run(stub, bybitBalance.fetchBalances(ctx(overrides)));
    const urls = stub.calls.map((c) => c.request.url.href);
    expect(urls.every((u) => u.startsWith("https://px.example/bybit/v5/"))).toBe(true);
  });
});

describe("failure classification", () => {
  const failWith = (reply: () => Response) =>
    failing(httpStub(reply), bybitBalance.validateAccount(ctx()));

  it("auth retCodes in a 200 are auth; other codes are the upstream's fault", async () => {
    for (const retCode of [10003, 10004, 10005, 10010, 33004]) {
      const stub = httpStub(() => json({ retCode, retMsg: "boom" }));
      expect(await run(stub, bybitBalance.validateAccount(ctx()))).toBe(false);
    }
    expect((await failWith(() => json({ retCode: 10016, retMsg: "boom" })))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("retCode and retMsg go into cause, not posing as an HTTP status", async () => {
    const err = await failWith(() => json({ retCode: 10016, retMsg: "server error" }));
    expect(err.status).toBeUndefined();
    expect(String(err.cause)).toBe("bybit retCode 10016: server error");
  });

  it("a bare null body is a parse failure, not a crash", async () => {
    expect((await failWith(() => json(null)))._tag).toBe("UpstreamParseError");
  });

  it("HTTP: 401 / 403 auth, 429 rate-limited with Retry-After, 5xx unavailable", async () => {
    for (const status of [401, 403]) {
      const stub = httpStub(() => json({}, { status }));
      expect(await run(stub, bybitBalance.validateAccount(ctx()))).toBe(false);
    }
    const limited = await failWith(() =>
      json({}, { status: 429, headers: { "retry-after": "2" } }),
    );
    expect(limited._tag === "UpstreamRateLimitError" && limited.retryAfterMs).toBe(2000);
    expect((await failWith(() => json({}, { status: 503 })))._tag).toBe("UpstreamUnavailableError");
  });

  it("errors carry neither the key nor the secret", async () => {
    const err = await failWith(() => json({}, { status: 503 }));
    expect(err.where).toBe("/v5/account/wallet-balance");
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.apiKey);
  });
});

describe("validateAccount", () => {
  it("retCode 0 → true", async () => {
    expect(
      await run(
        httpStub(() => json(wallet)),
        bybitBalance.validateAccount(ctx()),
      ),
    ).toBe(true);
  });
});
