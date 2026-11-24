import type { UpstreamNeeds } from "@folio/upstream-basic";
import { isRetryable, type UpstreamError } from "@folio/upstream-basic";
import { type HttpStub, httpStub, runClient } from "@folio/upstreams/testing";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import type { BinanceRow } from "../../../src/connectors/binance/parse";
import { binanceProvider, verdict } from "../../../src/connectors/binance/provider";
import account from "./fixtures/account.json";
import coinmAccount from "./fixtures/coinm-account.json";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnLocked from "./fixtures/earn-locked.json";
import fundingAssets from "./fixtures/funding-assets.json";
import futuresAccount from "./fixtures/futures-account.json";

// `runClient` provides a fake HttpClient plus TestClock, so signature timestamps are deterministic.
const PRICES: Record<string, string> = { BTCUSDT: "60000", ETHUSDT: "3000" };
const tickerBody = Object.entries(PRICES).map(([symbol, price]) => ({ symbol, price }));

// Routes by pathname; anything not given answers as an empty account.
function upstream(routes: Record<string, () => Response>): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes("/dapi/v1/account")) return json({ assets: [], positions: [] });
    if (path.includes("/fapi/v2/account")) return json({ totalMarginBalance: "0", positions: [] });
    if (path.includes("/api/v3/account")) return json({ balances: [] });
    // Earn endpoints return a paging envelope, not an array.
    if (path.includes("/simple-earn/")) return json({ rows: [], total: 0 });
    if (path.includes("/sapi/")) return json([]);
    return json(tickerBody); // /api/v3/ticker/price
  });
}

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

type Ctx = Parameters<typeof binanceProvider.fetchBalances>[0];
const ctx = (
  creds: Record<string, string> = { apiKey: "k", secret: "s" },
  providerCreds: Record<string, string> = {},
): Ctx =>
  ({
    account: { id: "a1", label: "Binance", connectorId: "binance", creds },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);

const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

// Fed data directly to pin the verdict's own edges, notably the same-error-object rule.
describe("verdict", () => {
  const err = (tag: string) => ({ _tag: tag }) as unknown as UpstreamError;
  const row = (symbol: string): BinanceRow =>
    ({ symbol, amount: 1, value: 1, kind: "spot" }) as BinanceRow;
  const ok = (name: string, symbols: string[]) => ({
    wallet: { name },
    result: Result.succeed(symbols.map(row)),
  });
  const ko = (name: string, e: UpstreamError) => ({ wallet: { name }, result: Result.fail(e) });

  it("all succeed → merges every balance, no note", () => {
    const v = verdict([ok("Spot", ["BTC"]), ok("Funding", ["USDT"])], Result.succeed({}));
    expect(Result.isSuccess(v)).toBe(true);
    if (Result.isSuccess(v)) {
      expect(v.success.balances.map((b) => b.symbol)).toEqual(["BTC", "USDT"]);
      expect(v.success.note).toBeUndefined();
    }
  });

  it("partial failure (wallet's own error) → still succeeds; note names it with a reason", () => {
    const v = verdict(
      [ok("Spot", ["BTC"]), ko("Earn", err("UpstreamAuthError"))],
      Result.succeed({}),
    );
    expect(Result.isSuccess(v)).toBe(true);
    if (Result.isSuccess(v)) {
      expect(v.success.balances.map((b) => b.symbol)).toEqual(["BTC"]);
      expect(String(v.success.note?.[0]?.content)).toContain("Earn");
      expect(String(v.success.note?.[0]?.content)).toContain("permissions");
    }
  });

  it("partial failure that isn't a permission error → note doesn't suggest checking permissions", () => {
    const v = verdict(
      [ok("Spot", ["BTC"]), ko("Earn", err("UpstreamParseError"))],
      Result.succeed({}),
    );
    expect(Result.isSuccess(v)).toBe(true);
    if (Result.isSuccess(v)) {
      expect(String(v.success.note?.[0]?.content)).toContain("Earn");
      expect(String(v.success.note?.[0]?.content)).not.toContain("permissions");
    }
  });

  it("a wallet died on the price table (same error object) → fails with the price table's error", () => {
    const priceErr = err("UpstreamRateLimitError");
    const v = verdict(
      [ok("USDⓈ-M Futures", ["USDT"]), ko("Spot", priceErr)],
      Result.fail(priceErr),
    );
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(priceErr);
  });

  it("partial transient failure (rate limit / timeout / 5xx) → fails whole for retry, no partial snapshot", () => {
    const transient = err("UpstreamUnavailableError");
    const v = verdict([ok("Spot", ["BTC"]), ko("Funding", transient)], Result.succeed({}));
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(transient);
  });

  it("transient mixed with auth → fails with the transient one (it's the reason to retry)", () => {
    const transient = err("UpstreamRateLimitError");
    const v = verdict(
      [ok("Spot", ["BTC"]), ko("Earn", err("UpstreamAuthError")), ko("Funding", transient)],
      Result.succeed({}),
    );
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(transient);
  });

  it("price table down but no wallet died on it → not collateral; wallet's own error rules", () => {
    // Same tag, different object → not collateral.
    const own = err("UpstreamRateLimitError");
    const v = verdict(
      [ok("USDⓈ-M Futures", ["USDT"]), ko("Spot", own)],
      Result.fail(err("UpstreamRateLimitError")),
    );
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(own);
  });

  it("everything failed → fails with the first wallet's error", () => {
    const first = err("UpstreamUnavailableError");
    const v = verdict(
      [ko("Spot", first), ko("Funding", err("UpstreamUnavailableError"))],
      Result.succeed({}),
    );
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(first);
  });
});

describe("fetchBalances", () => {
  it("signs /api/v3/account (apiKey header + signature), fetches public prices, then parses", async () => {
    const stub = upstream({ "/api/v3/account": () => json(account) });
    const { balances } = await run(stub, binanceProvider.fetchBalances(ctx()));

    expect(balances.map((b) => b.symbol)).toEqual(["BTC", "ETH", "USDT", "NOPRICE"]);
    // ETH has locked=1 → only its row carries a Locked note.
    expect(balances.find((b) => b.symbol === "ETH")?.note).toEqual({
      title: "Locked",
      icon: "warning",
      content: "1 ETH · 33%",
    });

    const signed = stub.calls.find((c) => c.request.url.pathname.includes("/api/v3/account"));
    expect(signed?.request.url.searchParams.get("signature")).toBeTruthy();
    expect(signed?.request.headers["x-mbx-apikey"]).toBe("k");
  });

  it("429 → rate limit; 401 → auth", async () => {
    const limited = httpStub(() => json({}, { status: 429, headers: { "retry-after": "2" } }));
    expect((await failing(limited, binanceProvider.fetchBalances(ctx())))._tag).toBe(
      "UpstreamRateLimitError",
    );
    const denied = httpStub(() => json({}, { status: 401 }));
    expect((await failing(denied, binanceProvider.fetchBalances(ctx())))._tag).toBe(
      "UpstreamAuthError",
    );
  });

  it("all five wallets succeed → spot + perp rows merged, no note", async () => {
    const stub = upstream({
      "/sapi/v1/simple-earn/flexible/position": () => json(earnFlexible),
      "/sapi/v1/simple-earn/locked/position": () => json(earnLocked),
      "/sapi/v1/asset/get-funding-asset": () => json(fundingAssets),
      "/dapi/v1/account": () => json(coinmAccount),
      "/fapi/v2/account": () => json(futuresAccount),
      "/api/v3/account": () => json(account),
    });
    const { balances, note } = await run(stub, binanceProvider.fetchBalances(ctx()));

    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(8); // spot 4 + funding 2 + earn 2
    expect(balances.filter((b) => b.kind === "perp_equity")).toHaveLength(2); // USDⓈ-M + COIN-M
    expect(balances.filter((b) => b.kind === "perp_position")).toHaveLength(4); // 2 each
    expect(note).toBeUndefined();
  });

  it("earn positions spanning pages are all fetched; later UNI/USDT aren't lost", async () => {
    // Pagination lives in the client; this pins the product behaviour (no coin goes missing).
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      asset: `A${i}`,
      totalAmount: "1",
      latestAnnualPercentageRate: "0.01",
    }));
    const page2 = [
      { asset: "UNI", totalAmount: "5", latestAnnualPercentageRate: "0.02" },
      { asset: "USDT", totalAmount: "100", latestAnnualPercentageRate: "0.03" },
    ];
    const stub = httpStub((request) => {
      const { pathname, searchParams } = request.url;
      if (pathname.includes("/simple-earn/flexible/position")) {
        return json({ rows: searchParams.get("current") === "2" ? page2 : page1, total: 102 });
      }
      if (pathname.includes("/simple-earn/locked/position")) return json({ rows: [], total: 0 });
      if (pathname.includes("/sapi/")) return json([]);
      if (pathname.includes("/dapi/v1/account")) return json({ assets: [], positions: [] });
      if (pathname.includes("/fapi/v2/account")) {
        return json({ totalMarginBalance: "0", positions: [] });
      }
      if (pathname.includes("/api/v3/account")) return json({ balances: [] });
      return json([{ symbol: "UNIUSDT", price: "10" }]);
    });

    const { balances } = await run(stub, binanceProvider.fetchBalances(ctx()));
    const earn = balances.filter((b) => b.note?.group === "earn");
    expect(earn).toHaveLength(102);
    expect(earn.some((b) => b.symbol === "UNI")).toBe(true);
    expect(earn.some((b) => b.symbol === "USDT")).toBe(true);
  });

  it("one wallet fails (no Futures permission → 401) → rest returned + account note, not a whole failure", async () => {
    const stub = upstream({
      "/fapi/v2/account": () => json({}, { status: 401 }),
      "/api/v3/account": () => json(account),
    });
    const { balances, note } = await run(stub, binanceProvider.fetchBalances(ctx()));

    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(4);
    expect(balances.some((b) => b.kind !== "spot")).toBe(false);
    expect(note?.[0]?.title).toBe("Wallets not synced");
    expect(String(note?.[0]?.content)).toContain("Futures");
  });

  it("the note names the wallet that actually failed, not one guessed by index", async () => {
    // Only Funding (4th in WALLETS) fails. 401 rather than 500: a transient error would fail the
    // whole account instead of producing a note.
    const stub = upstream({
      "/sapi/v1/asset/get-funding-asset": () => json({}, { status: 401 }),
      "/api/v3/account": () => json(account),
    });
    const { note } = await run(stub, binanceProvider.fetchBalances(ctx()));
    expect(String(note?.[0]?.content)).toContain("Funding");
    expect(String(note?.[0]?.content)).not.toContain("Spot");
    expect(String(note?.[0]?.content)).not.toContain("Earn");
  });

  // Four wallets need the price table to value anything; degrading would write a futures-only
  // snapshot that hides their real holdings. So its failure fails the whole account.
  it("price table down → whole account fails (retryable), no futures-only partial snapshot", async () => {
    const stub = upstream({
      "/api/v3/ticker/price": () => json({}, { status: 429 }),
      "/api/v3/account": () => json(account),
      "/fapi/v2/account": () => json(futuresAccount),
      "/dapi/v1/account": () => json(coinmAccount),
    });
    const err = await failing(stub, binanceProvider.fetchBalances(ctx()));

    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(isRetryable(err)).toBe(true);
  });

  it("price table down + one wallet down → still a whole failure; price table wins over best effort", async () => {
    // Keep one wallet alive (USDⓈ-M 200); with all five down the all-failed branch would pass
    // this even without the price-table rule.
    const stub = upstream({
      "/api/v3/ticker/price": () => json({}, { status: 503 }),
      "/sapi/v1/asset/get-funding-asset": () => json({}, { status: 401 }),
      "/api/v3/account": () => json(account),
      "/fapi/v2/account": () => json(futuresAccount),
    });
    const err = await failing(stub, binanceProvider.fetchBalances(ctx()));
    expect(isRetryable(err)).toBe(true);
  });

  // The reverse: the price-dependent wallets each died on their own signed call (401) before
  // joining the table, so its failure doesn't matter. Failing the account would discard the real
  // futures balance and retry for permissions that will never appear.
  it("price-dependent wallets die on auth (401) and the price table is down → still best effort with USDⓈ-M", async () => {
    const stub = upstream({
      "/api/v3/ticker/price": () => json({}, { status: 429 }),
      "/api/v3/account": () => json({}, { status: 401 }),
      "/sapi/v1/asset/get-funding-asset": () => json({}, { status: 401 }),
      "/dapi/v1/account": () => json({}, { status: 401 }),
      "/simple-earn/flexible/position": () => json({}, { status: 401 }),
      "/simple-earn/locked/position": () => json({}, { status: 401 }),
      "/fapi/v2/account": () => json(futuresAccount),
    });
    const { balances, note } = await run(stub, binanceProvider.fetchBalances(ctx()));

    expect(balances.some((b) => b.kind === "perp_equity")).toBe(true);
    expect(String(note?.[0]?.content)).toContain("Spot");
  });

  it("everything fails → failure, never an empty snapshot over existing balances", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, binanceProvider.fetchBalances(ctx()));
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });

  // Base overrides are passed to the client verbatim, one per host; no default host remains.
  it("each of the three base overrides takes effect and no default host remains", async () => {
    const overrides = {
      BINANCE_API_BASE: "https://px.example/s/binance",
      BINANCE_FAPI_BASE: "https://px.example/s/binance-fapi",
      BINANCE_DAPI_BASE: "https://px.example/s/binance-dapi",
    };
    // Exactly the declared keys, all public (not encrypted / exported, not in the account form).
    expect(binanceProvider.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(binanceProvider.creds.every((f) => f.type === "public")).toBe(true);

    const stub = upstream({});
    await run(stub, binanceProvider.fetchBalances(ctx({ apiKey: "k", secret: "s" }, overrides)));

    const urls = stub.calls.map((c) => c.request.url.href);
    const hit = (prefix: string) => urls.some((u) => u.startsWith(prefix));
    expect(hit("https://px.example/s/binance/api/v3/account")).toBe(true);
    expect(hit("https://px.example/s/binance/api/v3/ticker/price")).toBe(true);
    expect(hit("https://px.example/s/binance-fapi/fapi/v2/account")).toBe(true);
    expect(hit("https://px.example/s/binance-dapi/dapi/v1/account")).toBe(true);
    expect(urls.some((u) => u.includes("binance.com"))).toBe(false);
  });
});

// Rejected creds → `false`; unreachable upstream → error channel. Missing creds are guarded earlier
// by `validateCredentials`.
describe("validateAccount", () => {
  it("200 → true", async () => {
    const stub = httpStub(() => json({}));
    expect(await run(stub, binanceProvider.validateAccount(ctx()))).toBe(true);
  });

  it("rejected credentials (401) → false, not the error channel", async () => {
    const stub = httpStub(() => json({}, { status: 401 }));
    expect(await run(stub, binanceProvider.validateAccount(ctx()))).toBe(false);
  });

  // Binance uses HTTP 400 for a bad secret (-1022) / malformed key (-2014): credentials, not retried.
  it("rejected signature (400) → false, sent only once", async () => {
    const stub = httpStub(() => json({ code: -1022, msg: "Signature invalid" }, { status: 400 }));
    expect(await run(stub, binanceProvider.validateAccount(ctx()))).toBe(false);
    expect(stub.calls).toHaveLength(1);
  });

  it("429 → rate limit (retryable), not collapsed to false", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    const err = await failing(stub, binanceProvider.validateAccount(ctx()));
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(isRetryable(err)).toBe(true);
  });

  it("5xx → upstream unavailable (retryable)", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, binanceProvider.validateAccount(ctx()));
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });
});
