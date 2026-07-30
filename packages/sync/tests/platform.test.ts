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

  it("手记没选币:命名者就是自己(manual),走常规路径", () => {
    // manual 账户不经 sync 编排(isSyncableAccount 已挡),这里只验函数对 manual 命名者的常规行为。
    expect(platformOf("manual/custom:FOO", "manual")).toBe("manual");
  });

  it("读不懂的串 → 回落 connectorId,不产半截平台键", () => {
    expect(platformOf("nonsense", "binance")).toBe("binance");
    expect(platformOf("", "evm")).toBe("evm");
  });
});
