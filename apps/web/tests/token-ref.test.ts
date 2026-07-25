import { describe, expect, it } from "vitest";
import { chainOf } from "../src/lib/token-ref";

// 「命名者是不是一条链」看右半边,不查表(ADR 0020)。链命名者同时就是 platforms.id(短形)。
describe("chainOf", () => {
  it("链上寻址 → 命名者(可直接当 platforms.id 用)", () => {
    expect(chainOf("eip155:1/erc20:0xabc")).toBe("eip155:1");
    expect(chainOf("eip155:42161/native")).toBe("eip155:42161");
    expect(chainOf("bitcoin/native")).toBe("bitcoin");
    expect(chainOf("solana/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("solana");
  });

  it("不透明 id 形的 ref 不是链 → undefined(落账户平台)", () => {
    expect(chainOf("coingecko/usd-coin")).toBeUndefined();
    expect(chainOf("binance/USDC")).toBeUndefined();
    expect(chainOf("hyperliquid/BTC")).toBeUndefined();
  });

  it("无 ref / 读不懂的串 → undefined", () => {
    expect(chainOf(null)).toBeUndefined();
    expect(chainOf(undefined)).toBeUndefined();
    expect(chainOf("")).toBeUndefined();
    // 迁移前的旧形已不认(数据由 0006 迁移改写)。
    expect(chainOf("chain:bitcoin/native:btc")).toBeUndefined();
  });
});
