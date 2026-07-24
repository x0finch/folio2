import { env } from "cloudflare:test";
import type { CgkCoinId, TokenRef } from "@folio/tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { createTokenPriceHistoryStore } from "../src";

// 历史日价缓存 store 的 D1 集成(#148 / ADR 0019)。真实 D1(Miniflare)。pool 不隔离每测存储 → beforeEach 重置。
const store = () => createTokenPriceHistoryStore(env);
const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });
const btc = cg("bitcoin");
const eth = cg("ethereum");

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM token_price_history").run();
});

describe("createTokenPriceHistoryStore", () => {
  it("put → get round-trips by (ref, dayBuckets); 只回请求的桶", async () => {
    const s = store();
    await s.putDailyPrices(btc, [
      { dayBucket: 18500, unitPrice: 60000 },
      { dayBucket: 18501, unitPrice: 61000 },
      { dayBucket: 18502, unitPrice: 62000 },
    ]);
    const got = await s.getDailyPrices(btc, [18500, 18502, 99999]);
    expect(got.get(18500)).toBe(60000);
    expect(got.get(18502)).toBe(62000);
    expect(got.has(18501)).toBe(false); // 未请求
    expect(got.has(99999)).toBe(false); // 无此桶
  });

  it("不串源 / 不串币", async () => {
    const s = store();
    await s.putDailyPrices(btc, [{ dayBucket: 18500, unitPrice: 60000 }]);
    await s.putDailyPrices(eth, [{ dayBucket: 18500, unitPrice: 3000 }]);
    const btcGot = await s.getDailyPrices(btc, [18500]);
    expect(btcGot.get(18500)).toBe(60000);
    expect(btcGot.size).toBe(1); // ethereum 同桶不混入
    expect((await s.getDailyPrices(eth, [18500])).get(18500)).toBe(3000);
  });

  it("同键再 put → upsert 覆盖(历史价被修正时)", async () => {
    const s = store();
    await s.putDailyPrices(btc, [{ dayBucket: 18500, unitPrice: 60000 }]);
    await s.putDailyPrices(btc, [{ dayBucket: 18500, unitPrice: 60500 }]);
    expect((await s.getDailyPrices(btc, [18500])).get(18500)).toBe(60500);
  });

  it("空写 → no-op;>90 桶的读走分块(不炸 D1 参数上限)", async () => {
    const s = store();
    await s.putDailyPrices(btc, []); // no-op,不抛
    const buckets = Array.from({ length: 200 }, (_, i) => 18000 + i);
    await s.putDailyPrices(
      btc,
      buckets.map((b) => ({ dayBucket: b, unitPrice: b })),
    );
    const got = await s.getDailyPrices(btc, buckets);
    expect(got.size).toBe(200);
    expect(got.get(18000)).toBe(18000);
    expect(got.get(18199)).toBe(18199);
  });
});
