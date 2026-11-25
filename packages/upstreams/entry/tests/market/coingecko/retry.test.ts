import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MARKETS_PER_PAGE, RETRY_MAX_WAIT_MS } from "../../../src/market/coingecko/constants";
import { makeTokenEffects } from "../../../src/market/coingecko/token";
import { run, runDriven, type Stub, stubbing } from "./harness";

// Retry policy lives in this package (the Effect client has none), so it is pinned here.
// Asserts attempt counts, not time waited.

const platforms = [{ id: "ethereum", chain_identifier: 1, name: "Ethereum" }];

// First n requests fail with the given status, then succeed.
const failingFirst = (n: number, status: number): Stub =>
  stubbing((_call, nth) => (nth < n ? new Error(String(status)) : platforms));

// 429 + Retry-After (build a `Response`; the sentinel carries only a status code).
const rateLimited = (retryAfterSec: number, failures: number): Stub =>
  stubbing((_call, nth) =>
    nth < failures
      ? new Response(null, { status: 429, headers: { "retry-after": String(retryAfterSec) } })
      : platforms,
  );

describe("which errors trigger another attempt", () => {
  it("5xx means upstream unreachable: one retry succeeds", async () => {
    const stub = failingFirst(1, 503);
    await runDriven(stub, makeTokenEffects().fetchMarkets({ topN: 1 }));
    expect(stub.calls).toHaveLength(2);
  });

  it("retries are capped: persistent 5xx gives up after two attempts", async () => {
    const stub = failingFirst(99, 503);
    const err = await runDriven(stub, Effect.flip(makeTokenEffects().fetchMarkets({ topN: 1 })));
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(stub.calls).toHaveLength(2);
  });

  it("401 is a credentials problem: gives up after one attempt", async () => {
    const stub = failingFirst(99, 401);
    const err = await run(stub, Effect.flip(makeTokenEffects().fetchMarkets({ topN: 1 })));
    expect(err._tag).toBe("UpstreamAuthError");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("Retry-After: honour upstream, within a tolerable cap", () => {
  it("a wait within the cap: waits, then retries once", async () => {
    const stub = rateLimited(1, 1); // 1 second, within the 2s cap
    await runDriven(stub, makeTokenEffects().fetchMarkets({ topN: 1 }));
    expect(stub.calls).toHaveLength(2);
  });

  // Equivalent of `exceedsMaxWait: "throw"`, deliberately opposite to the background-sync clamp: this path may
  // sit on a user's write path, so fail fast and let SWR serve stale.
  it("a wait over the cap: gives up immediately instead of clamping and waiting", async () => {
    const stub = rateLimited(RETRY_MAX_WAIT_MS / 1000 + 58, 99); // 60 seconds, far over the cap
    const err = await runDriven(stub, Effect.flip(makeTokenEffects().fetchMarkets({ topN: 1 })));
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("retry granularity is one request, not one method", () => {
  // A failed page 2 in `fetchMarkets` retries page 2 only, not from page 1.
  it("failure mid-pagination: only the failed page is retried", async () => {
    const rows = (pageNo: number) =>
      Array.from({ length: MARKETS_PER_PAGE }, (_, i) => ({
        id: `coin-${(pageNo - 1) * MARKETS_PER_PAGE + i}`,
        symbol: "c",
        name: "c",
        current_price: 1,
      }));

    let secondPageTries = 0;
    const stub = stubbing((call) => {
      const page = Number(call.query.get("page"));
      if (page === 2 && ++secondPageTries === 1) return new Error("503");
      return page >= 3 ? [] : rows(page);
    });

    await runDriven(stub, makeTokenEffects().fetchMarkets({ topN: MARKETS_PER_PAGE * 3 }));

    const pages = stub.calls.map((c) => c.query.get("page"));
    expect(pages.filter((p) => p === "1")).toHaveLength(1); // page 1 not repeated
    expect(pages.filter((p) => p === "2")).toHaveLength(2); // failed page retried once
  });
});

describe("two concurrent requests retry independently", () => {
  // `fetchRefIndex` fetches catalogue and platform table together; if the platform table fails only it retries.
  it("only one of two endpoints fails: only that one is retried", async () => {
    let platformTries = 0;
    const stub = stubbing((call) => {
      if (!call.path.includes("/asset_platforms")) return [];
      return ++platformTries === 1 ? new Error("503") : platforms;
    });

    await runDriven(stub, makeTokenEffects().fetchRefIndex());

    expect(stub.calls.filter((c) => c.path.includes("/asset_platforms"))).toHaveLength(2);
    expect(stub.calls.filter((c) => c.path.includes("/coins/list"))).toHaveLength(1);
  });
});
