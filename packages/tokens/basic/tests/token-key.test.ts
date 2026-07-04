import { describe, expect, it } from "vitest";
import { buildTokenKey } from "../src/token-key";

describe("buildTokenKey (CAIP-19 文法)", () => {
  it("有数字 chainId 的合约 → eip155 标准形(小写归一)", () => {
    expect(buildTokenKey({ chain: "arbitrum", chainId: 42161, contract: "0xAF88D065" })).toBe(
      "eip155:42161/erc20:0xaf88d065",
    );
  });

  it("无数字 chainId 的合约 → chain:<slug>/token 兜底形", () => {
    expect(buildTokenKey({ chain: "Solana", contract: "Mint111" })).toBe(
      "chain:solana/token:mint111",
    );
  });

  it("原生币(有 chainId)→ eip155/native:<symbol>(symbol 仅可读标签)", () => {
    expect(buildTokenKey({ chain: "base", chainId: 8453, native: true, symbol: "ETH" })).toBe(
      "eip155:8453/native:eth",
    );
    // BSC 原生 BNB
    expect(
      buildTokenKey({
        chain: "binance-smart-chain",
        chainId: 56,
        native: true,
        symbol: "BNB",
      }),
    ).toBe("eip155:56/native:bnb");
  });

  it("原生币(无 chainId)→ chain:<slug>/native 兜底形", () => {
    expect(buildTokenKey({ chain: "ethereum", native: true, symbol: "ETH" })).toBe(
      "chain:ethereum/native:eth",
    );
  });

  it("仅 CGK id、无链上寻址 → coingecko:<id>", () => {
    expect(buildTokenKey({ cgkId: "bitcoin" })).toBe("coingecko:bitcoin");
  });

  it("合约优先于 cgkId", () => {
    expect(buildTokenKey({ chainId: 1, contract: "0xabc", cgkId: "some-coin" })).toBe(
      "eip155:1/erc20:0xabc",
    );
  });

  it("无任何寻址 → undefined", () => {
    expect(buildTokenKey({ symbol: "ETH" })).toBeUndefined(); // native 未置位、无链
    expect(buildTokenKey({ native: true, symbol: "ETH" })).toBeUndefined(); // 缺链前缀
    expect(buildTokenKey({ chain: "base", chainId: 8453 })).toBeUndefined(); // 无合约/非 native
  });
});
