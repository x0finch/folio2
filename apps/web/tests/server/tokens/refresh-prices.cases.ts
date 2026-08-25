import { beforeEach, describe, expect, it } from "vitest";
import { handleListTokens } from "@/lib/server/tokens/list";
import {
  handleRefreshTokenPrices,
  RefreshTokenPricesInput,
} from "@/lib/server/tokens/refresh-prices";
import { json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// 合并进 tokens/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tokens/refresh-prices", () => {
  // #527 · refreshTokenPrices
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
    it("传空数组 → 返回空,一发外呼都不发", async () => {
      const outbound = stubOutbound([["/simple/price", () => json(PRICE)]]);

      expect(await call(USER, handleRefreshTokenPrices({ tickets: [] }))).toEqual([]);
      expect(outbound.calls).toEqual([]);
    });

    it("同一张票重复传十次 → 只算一次,不发十遍请求", async () => {
      const [btc] = await tickets();
      const outbound = stubOutbound([["/simple/price", () => json(PRICE)]]);

      await call(
        USER,
        handleRefreshTokenPrices({ tickets: Array.from({ length: 10 }, () => btc) }),
      );

      expect(outbound.calls).toHaveLength(1);
    });

    it("传 201 张 → schema 拒(上限 200)", () => {
      const many = Array.from({ length: 201 }, (_, i) => `t${i}`);
      expect(RefreshTokenPricesInput.safeParse({ tickets: many }).success).toBe(false);
      expect(RefreshTokenPricesInput.safeParse({ tickets: many.slice(0, 200) }).success).toBe(true);
    });

    it("票里有空串 → schema 拒", () => {
      expect(RefreshTokenPricesInput.safeParse({ tickets: [""] }).success).toBe(false);
    });
  });
});
