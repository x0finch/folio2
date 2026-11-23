import { beforeEach, describe, expect, it } from "vitest";
import { handleListTokens } from "@/lib/server/tokens/list";
import {
  handleRefreshTokenPrices,
  RefreshTokenPricesInput,
} from "@/lib/server/tokens/refresh-prices";
import { json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// Runs inside tokens/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tokens/refresh-prices", () => {
  const USER = "h-tok-refresh";

  const SEARCH = {
    coins: [
      { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 },
      { id: "ethereum", symbol: "eth", name: "Ethereum", market_cap_rank: 2 },
    ],
  };
  const PRICE = {
    bitcoin: { usd: 50_000, usd_24h_change: 1, last_updated_at: 1_700_000_000 },
    ethereum: { usd: 3_000, usd_24h_change: -2, last_updated_at: 1_700_000_000 },
  };

  const tickets = async () => {
    stubOutbound([["/search", () => json(SEARCH)]]);
    const out = await call(USER, handleListTokens({ query: `q-${crypto.randomUUID()}` }));
    return out.map((o) => o.ticket);
  };

  beforeEach(async () => {
    await freshUser(USER);
  });

  describe("refreshTokenPrices", () => {
    it("empty array -> returns empty, no outbound call", async () => {
      const outbound = stubOutbound([["/simple/price", () => json(PRICE)]]);

      expect(await call(USER, handleRefreshTokenPrices({ tickets: [] }))).toEqual([]);
      expect(outbound.calls).toEqual([]);
    });

    it("the same ticket passed ten times -> computed once, not ten requests", async () => {
      const [btc] = await tickets();
      const outbound = stubOutbound([["/simple/price", () => json(PRICE)]]);

      await call(
        USER,
        handleRefreshTokenPrices({ tickets: Array.from({ length: 10 }, () => btc) }),
      );

      expect(outbound.calls).toHaveLength(1);
    });

    it("201 tickets -> rejected by schema (cap 200)", () => {
      const many = Array.from({ length: 201 }, (_, i) => `t${i}`);
      expect(RefreshTokenPricesInput.safeParse({ tickets: many }).success).toBe(false);
      expect(RefreshTokenPricesInput.safeParse({ tickets: many.slice(0, 200) }).success).toBe(true);
    });

    it("empty string among the tickets -> rejected by schema", () => {
      expect(RefreshTokenPricesInput.safeParse({ tickets: [""] }).success).toBe(false);
    });
  });
});
