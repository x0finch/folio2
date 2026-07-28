import { describe, expect, it } from "vitest";
import { platformOf } from "../src/platform";

// 平台在写快照时算一次、落库,读端只读那一列(#193)。规则:平台 = tokenRef 的命名者。
describe("platformOf", () => {
  it("链上持仓:命名者就是它所在的链", () => {
    expect(platformOf("evm:1/contract:0xa0b8", "evm")).toBe("evm:1");
    expect(platformOf("evm:42161/contract:0xaf88", "evm")).toBe("evm:42161"); // 同账户跨链 → 各成一格
    expect(platformOf("bitcoin/native", "bitcoin")).toBe("bitcoin");
    expect(platformOf("solana/contract:EPjFWdd5", "solana")).toBe("solana");
  });

  it("场馆:命名者就是场馆自己(与 connectorId 天然重合)", () => {
    expect(platformOf("binance/issued:USDC", "binance")).toBe("binance");
    expect(platformOf("okx/issued:BTC", "okx")).toBe("okx");
    expect(platformOf("hyperliquid/issued:ETH", "hyperliquid")).toBe("hyperliquid");
  });

  it("唯一例外:价格源作命名者(手记选了币)→ 回落 connectorId", () => {
    // `coingecko/bitcoin` 说的是「谁管它叫什么」,不是「它在哪」—— 手记的位置是 manual。
    expect(platformOf("coingecko/issued:bitcoin", "manual")).toBe("manual");
    // 手记没选币时命名者就是自己,走常规路径,答案一样。
    expect(platformOf("manual/custom:FOO", "manual")).toBe("manual");
  });

  it("读不懂的串 → 回落 connectorId,不产半截平台键", () => {
    expect(platformOf("nonsense", "binance")).toBe("binance");
    expect(platformOf("", "evm")).toBe("evm");
  });
});
