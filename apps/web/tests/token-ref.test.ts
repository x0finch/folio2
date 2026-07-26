import { describe, expect, it } from "vitest";
import { chainAddressOf, chainOf } from "../src/lib/token-ref";

// 文法收窄后「是不是链上寻址」看左半边(命名者是不是场馆/数据源),不看右半边形状 —— 见 #192。
// 链命名者同时就是 platforms.id(短形)。#193 让 provider 直接报平台之后,这两个函数整个删除。
describe("chainOf", () => {
  it("链上寻址 → 命名者(可直接当 platforms.id 用)", () => {
    expect(chainOf("evm:1/0xabc")).toBe("evm:1");
    expect(chainOf("evm:42161/native")).toBe("evm:42161");
    expect(chainOf("bitcoin/native")).toBe("bitcoin");
    expect(chainOf("solana/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("solana");
  });

  it("场馆 / 数据源命名不是链 → undefined(落账户平台)", () => {
    expect(chainOf("coingecko/usd-coin")).toBeUndefined();
    expect(chainOf("binance/USDC")).toBeUndefined();
    expect(chainOf("okx/BTC")).toBeUndefined();
    expect(chainOf("hyperliquid/BTC")).toBeUndefined();
  });

  it("无 ref / 读不懂的串 → undefined", () => {
    expect(chainOf(null)).toBeUndefined();
    expect(chainOf(undefined)).toBeUndefined();
    expect(chainOf("")).toBeUndefined();
    expect(chainOf("coingecko:usd-coin")).toBeUndefined(); // 无斜杠 → unknown
  });
});

describe("chainAddressOf", () => {
  it("只认「链命名者 + 非原生币」—— sync 采集 provider 元信息的口径", () => {
    expect(chainAddressOf("evm:1/0xabc")).toBe("evm:1/0xabc");
    expect(chainAddressOf("solana/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      "solana/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  it("原生币 / 场馆 / CGK 命名 / 空 → undefined(各走自己的解析路径)", () => {
    expect(chainAddressOf("bitcoin/native")).toBeUndefined();
    expect(chainAddressOf("evm:1/native")).toBeUndefined();
    expect(chainAddressOf("binance/USDC")).toBeUndefined();
    expect(chainAddressOf("coingecko/usd-coin")).toBeUndefined();
    expect(chainAddressOf(null)).toBeUndefined();
  });
});
