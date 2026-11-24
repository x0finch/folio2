import { beforeEach, describe, expect, it } from "vitest";
import { handleListTokens } from "@/lib/server/tokens/list";
import { handleGetTokenPrice, TokenPriceInput } from "@/lib/server/tokens/price";
import { countRows } from "../_kit/db";
import { json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// Runs inside tokens/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tokens/price", () => {
  // The ticket comes from search results, matching the user's real path (search, click, then price) and avoiding a hand-forged ticket
  // whose encoding may have changed.
  const USER = "h-tok-price";

  const SEARCH = { coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 }] };
  const PRICE = { bitcoin: { usd: 50_000, usd_24h_change: 2.5, last_updated_at: 1_700_000_000 } };

  const ticketOfBtc = async () => {
    stubOutbound([["/search", () => json(SEARCH)]]);
    const [first] = await call(USER, handleListTokens({ query: `btc-${crypto.randomUUID()}` }));
    return first.ticket;
  };

  beforeEach(async () => {
    await freshUser(USER);
  });

  describe("getTokenPrice", () => {
    it("a known token's ticket -> gets unit price, change and fetch time", async () => {
      const ticket = await ticketOfBtc();
      stubOutbound([["/simple/price", () => json(PRICE)]]);

      const out = await call(USER, handleGetTokenPrice({ ticket }));

      expect(out?.unitPrice).toBe(50_000);
      expect(out?.change24h).toBeCloseTo(2.5, 6);
      expect(out?.asOf).toBeTruthy();
    });

    it("upstream has no price for the coin -> returns null, not 0", async () => {
      // 0 would read as "this coin is worthless" when the truth is "we don't know".
      const ticket = await ticketOfBtc();
      stubOutbound([["/simple/price", () => json({})]]);

      expect(await call(USER, handleGetTokenPrice({ ticket }))).toBeNull();
    });

    it("clicking creates no row -- fetching a price must not persist a token row", async () => {
      const ticket = await ticketOfBtc();
      stubOutbound([["/simple/price", () => json(PRICE)]]);
      const before = await countRows("tokens", USER);

      await call(USER, handleGetTokenPrice({ ticket }));

      expect(await countRows("tokens", USER)).toBe(before);
    });

    it("forged / undecodable ticket -> never sent upstream", async () => {
      const outbound = stubOutbound([["/simple/price", () => json(PRICE)]]);

      const out = await call(USER, handleGetTokenPrice({ ticket: "not a ticket" })).catch(
        () => null,
      );

      expect(out).toBeNull();
      expect(outbound.calls).toEqual([]);
    });

    it("empty ticket -> rejected by schema", () => {
      expect(TokenPriceInput.safeParse({ ticket: "" }).success).toBe(false);
    });
  });
});
