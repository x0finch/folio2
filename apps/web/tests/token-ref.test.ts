import { describe, expect, it } from "vitest";
import { chainNamerOf } from "../src/lib/token-ref";

// 「命名者是不是一条链」看右半边,不查表(ADR 0020)。链命名者同时就是 platforms.id(短形)。
describe("chainNamerOf", () => {
  it("链上寻址 → 命名者(可直接当 platforms.id 用)", () => {
    expect(chainNamerOf("eip155:1/erc20:0xabc")).toBe("eip155:1");
    expect(chainNamerOf("eip155:42161/native")).toBe("eip155:42161");
    expect(chainNamerOf("bitcoin/native")).toBe("bitcoin");
    expect(chainNamerOf("solana/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      "solana",
    );
  });

  it("不透明 id 形的 ref 不是链 → undefined(落账户平台)", () => {
    expect(chainNamerOf("coingecko/usd-coin")).toBeUndefined();
    expect(chainNamerOf("binance/USDC")).toBeUndefined();
    expect(chainNamerOf("hyperliquid/BTC")).toBeUndefined();
  });

  it("无 ref / 读不懂的串 → undefined", () => {
    expect(chainNamerOf(null)).toBeUndefined();
    expect(chainNamerOf(undefined)).toBeUndefined();
    expect(chainNamerOf("")).toBeUndefined();
    // 迁移前的旧形已不认(数据由 0006 迁移改写)。
    expect(chainNamerOf("chain:bitcoin/native:btc")).toBeUndefined();
  });
});
