import { beforeEach, describe, expect, it } from "vitest";
import { handleListTokenCatalogue } from "@/lib/server/tokens/catalogue";
import { handleListTokens, ListTokensInput } from "@/lib/server/tokens/list";
import { countRows } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// Runs inside tokens/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tokens/list", () => {
  // The most important thing here is that clicking a candidate creates no row: picking a coin is a read, so browsing ten candidates
  // must not leave ten junk rows. The upstream is stubbed with fixed answers; both endpoints' results are user-independent (no userId in the edge cache key).
  const USER = "h-tok-list";

  const MARKETS = [
    { id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 50_000, market_cap_rank: 1 },
    { id: "ethereum", symbol: "eth", name: "Ethereum", current_price: 3_000, market_cap_rank: 2 },
  ];
  const SEARCH = {
    coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 }],
  };

  beforeEach(async () => {
    await freshUser(USER);
  });

  describe("listTokenCatalogue", () => {
    it("returns a batch of popular coins, each with a symbol and display name", async () => {
      stubOutbound([["/coins/markets", () => json(MARKETS)]]);

      const out = await call(USER, handleListTokenCatalogue());

      expect(out.length).toBeGreaterThan(0);
      expect(out[0].symbol).toBeTruthy();
      expect(out[0].name).toBeTruthy();
    });

    it("what's handed out is a ticket, not an internal id", async () => {
      // The other half of click-creates-no-row: no token row exists yet, so only an encoded reference can be given.
      stubOutbound([["/coins/markets", () => json(MARKETS)]]);

      const out = await call(USER, handleListTokenCatalogue());

      expect(out[0].ticket).toBeTruthy();
      expect(out[0]).not.toHaveProperty("id");
    });

    it("clicking creates no row -- the token row count is unchanged after the call", async () => {
      stubOutbound([["/coins/markets", () => json(MARKETS)]]);
      const before = await countRows("tokens", USER);

      await call(USER, handleListTokenCatalogue());

      expect(await countRows("tokens", USER)).toBe(before);
    });

    it("upstream down but edge cache has it -> returns the cached copy, no error", async () => {
      // Workers Cache really takes effect in this harness (it's a no-op only on workers.dev), so this case is testable rather than inferred.
      stubOutbound([["/coins/markets", () => json(MARKETS)]]);
      const warm = await call(USER, handleListTokenCatalogue());
      expect(warm.length).toBeGreaterThan(0);

      stubOutbound([["/coins/markets", () => json({ error: "boom" }, 500)]]);
      const out = await call(USER, handleListTokenCatalogue());

      expect(out).toEqual(warm);
    });
  });

  describe("listTokens (long-tail search)", () => {
    it("search btc -> Bitcoin is in the results", async () => {
      stubOutbound([["/search", () => json(SEARCH)]]);

      const out = await call(USER, handleListTokens({ query: "btc" }));

      expect(out.map((o) => o.symbol.toLowerCase())).toContain("btc");
    });

    it("empty query / whitespace only -> returns empty with no outbound call", async () => {
      // `blockOutbound` makes any outbound call throw, so not throwing proves none was made; asserting calls is empty too
      // makes a failure name the URL that was hit.
      const outbound = blockOutbound();

      expect(await call(USER, handleListTokens({ query: "" }))).toEqual([]);
      expect(await call(USER, handleListTokens({ query: "   " }))).toEqual([]);
      expect(outbound.calls).toEqual([]);
    });

    it("clicking creates no row -- ten searches leave no junk row", async () => {
      stubOutbound([["/search", () => json(SEARCH)]]);
      const before = await countRows("tokens", USER);

      for (const q of [
        "b",
        "bt",
        "btc",
        "btc ",
        "bitc",
        "bitco",
        "bitcoi",
        "bitcoin",
        "btcx",
        "x",
      ]) {
        await call(USER, handleListTokens({ query: q }));
      }

      expect(await countRows("tokens", USER)).toBe(before);
    });

    it("special characters in the query -> don't break the upstream URL (what's sent is encoded)", async () => {
      const outbound = stubOutbound([["/search", () => json({ coins: [] })]]);

      await call(USER, handleListTokens({ query: "a&b=c?d#e" }));

      expect(outbound.calls).toHaveLength(1);
      expect(outbound.calls[0]).not.toContain("a&b=c?d#e");
      expect(outbound.calls[0]).toContain("a%26b");
    });

    it("upstream down and no cache (fresh keyword) -> explicit failure, not a silently partial result", async () => {
      // Use a keyword never searched, or it would hit the cache left by the previous case and miss the cold-start half.
      stubOutbound([["/search", () => json({ error: "boom" }, 500)]]);

      await expect(
        call(USER, handleListTokens({ query: "cold-start-only keyword" })),
      ).rejects.toThrow();
    });

    it("query absent -> rejected by schema", () => {
      expect(ListTokensInput.safeParse({}).success).toBe(false);
    });
  });
});
