import { describe, expect, it } from "vitest";
// 白盒:registry 机制是 @folio/balances 内部件(不对外导出)。
import { getProvider, registry } from "../src/registry";

describe("默认 registry(manifest 解析而来,ADR 0009)", () => {
  it("覆盖现有全部账户类型,provider 为纯行为(无 accountType 身份)", () => {
    expect(Object.keys(registry).sort()).toEqual(
      [
        "exchange_binance",
        "exchange_okx",
        "manual",
        "onchain_bitcoin",
        "onchain_cosmos",
        "onchain_evm",
        "onchain_solana",
        "onchain_sui",
        "perp_hyperliquid",
      ].sort(),
    );
    const p = getProvider(registry, "manual");
    expect(typeof p.fetchBalances).toBe("function");
    expect("accountType" in p).toBe(false); // 身份归 manifest,不在 provider 实现上
  });

  it("getProvider:未注册类型 → 抛", () => {
    expect(() => getProvider({}, "exchange_binance")).toThrow(
      /No provider registered for account type: exchange_binance/,
    );
  });
});
