import { Duration, Effect, Option, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { GlobalRefIndexService, Oracle } from "../src";
import { FxService } from "../src/fx";
import { PlatformService } from "../src/platforms";
import { TokenService } from "../src/tokens";
import { harness, now0, upstreamDown } from "./fakes";

// Assembly layer: verifies which services `oracleLayer` provides and which ports it needs, and that the write path never goes
// to the network for catalogue freshness (mint and candidate-source unit tests cannot see which implementation is wired in).
// Per-user isolation is not testable here (the layer knows no userId); the `@folio/db` store tests pin it.

describe("oracleLayer: one assembly yields three services", () => {
  // The aggregate holds the actual services, not copies: `(yield* Oracle).fx` must be the same object as `yield* FxService`,
  // or a second set was built whose cache / SWR state diverges.
  it("the three fields of Oracle are the three domain services themselves", async () => {
    const h = harness();
    await h.run(
      Effect.gen(function* () {
        const oracle = yield* Oracle;
        expect(oracle.tokens).toBe(yield* TokenService);
        expect(oracle.fx).toBe(yield* FxService);
        expect(oracle.platforms).toBe(yield* PlatformService);
      }),
    );
  });

  it("`oracleLayer` is pure assembly: building it touches no port", async () => {
    const h = harness();
    await h.run(Effect.void);
    // Building only takes ports from context into closures: no read or write should happen.
    expect(h.cache.reads + h.cache.writes).toBe(0);
    expect(h.upstream.calls).toEqual([]);
    expect(h.store.rows.size).toBe(0);
  });
});

describe("global maintenance job is not on the per-user facade", () => {
  // `GlobalRefIndexService` is not in `oracleLayer`: cron provides just its layer and the two global ports, no fake user.
  it("refreshing the global ref-index needs no userId or per-user store: fetch, one whole write, record the refresh time", async () => {
    const h = harness();
    h.upstream.globalRefIndex = {
      rows: [
        { chainRef: "evm:1/contract:0xa0b8", upstreamRef: "src/issued:usd-coin" },
        { chainRef: "solana/contract:EPjF", upstreamRef: "src/issued:usd-coin" },
      ],
      unmatchedPlatforms: [],
      skipped: 7,
    };

    await h.run(
      Effect.gen(function* () {
        const svc = yield* GlobalRefIndexService;
        expect(yield* svc.refreshedAt()).toEqual(Option.none());

        const summary = yield* svc.warm();
        // Diff write: first refresh on an empty db gives two added rows, 0 changed / removed; counts flow from the store to the cron log.
        expect(summary).toEqual({
          rows: 2,
          unmatchedPlatforms: [],
          skipped: 7,
          updated: 0,
          inserted: 2,
          deleted: 0,
        });
        expect(h.globalRefIndex.writes).toBe(1); // one whole write
        // The time comes from `Clock`.
        expect(yield* svc.refreshedAt()).toEqual(Option.some(now0));
      }),
    );
  });

  // Warnings go through Effect's logger; where they land is decided by the Logger layer the cron provides.
  it("a mismatch logs one warning (with namer and chain name); no mismatch, no noise", async () => {
    const h = harness();
    h.upstream.globalRefIndex = { rows: [], unmatchedPlatforms: ["sui"], skipped: 0 };
    await h.run(Effect.flatMap(GlobalRefIndexService, (s) => s.warm()));

    const warns = h.logs.filter((l) => l.level === "WARN");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.annotations).toEqual({ namer: "src", platforms: ["sui"] });

    h.upstream.globalRefIndex = { rows: [], unmatchedPlatforms: [], skipped: 0 };
    await h.run(Effect.flatMap(GlobalRefIndexService, (s) => s.warm()));
    expect(h.logs.filter((l) => l.level === "WARN")).toHaveLength(1);
  });

  // Unlike the read path, cron must know the run was wasted (degrading here would turn one silent failure into two).
  it("upstream down: the error goes to cron, no degradation", async () => {
    const h = harness();
    h.upstream.fail = upstreamDown();
    const result = await h.run(
      Effect.either(Effect.flatMap(GlobalRefIndexService, (s) => s.warm())),
    );
    expect(result._tag).toBe("Left");
    expect(h.globalRefIndex.writes).toBe(0);
  });
});

// Core regression: the write path never fetches for catalogue freshness; the wiring is where it can break.
describe("the write path does not egress for catalogue freshness", () => {
  const POL = {
    ref: "src/issued:polygon-ecosystem-token",
    symbol: "POL",
    name: "POL",
    price: { unitPrice: 1, marketCapRank: 76, asOf: 0 },
  };

  it("after warm expires, mint by symbol makes zero requests", async () => {
    const h = harness();
    h.upstream.markets = [POL];
    await h.run(
      Effect.gen(function* () {
        // First let the showcase build the blob (the user opened the picker once).
        yield* Effect.flatMap(TokenService, (t) => t.topTokens(10));
        const after = h.upstream.calls.length;

        // Clock past the price TTL: the showcase would refresh, mint must not.
        yield* TestClock.adjust(Duration.millis(24 * 60 * 60 * 1000));
        const ids = yield* Effect.flatMap(TokenService, (t) =>
          t.mint([{ ref: "binance/issued:POL", seed: { symbol: "POL" } }]),
        );

        expect(ids.get("binance/issued:POL")).toBeDefined(); // recognised (via the old catalogue)
        expect(h.upstream.calls).toHaveLength(after); // and no network call
      }),
    );
  });

  it("control: same expiry, the showcase does refresh; the only difference is the reader", async () => {
    const h = harness();
    h.upstream.markets = [POL];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* tokens.topTokens(10);
        const after = h.upstream.calls.length;

        yield* TestClock.adjust(Duration.millis(24 * 60 * 60 * 1000));
        yield* tokens.topTokens(10);
        expect(h.upstream.calls.length).toBeGreaterThan(after);
      }),
    );
  });

  it("on a cold cache mint still fetches once, or symbol-matched tokens all go unrecognised", async () => {
    // `oracleLayer`'s `R` has no `CandidateSource`; the harness supplies only eight ports and the symbol tier still works.
    const h = harness();
    h.upstream.markets = [POL];
    const ids = await h.run(
      Effect.flatMap(TokenService, (t) =>
        t.mint([{ ref: "binance/issued:POL", seed: { symbol: "POL" } }]),
      ),
    );
    expect(ids.get("binance/issued:POL")).toBeDefined();
    expect(h.upstream.calls).toHaveLength(1);
  });
});
