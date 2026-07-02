import type { AccountType, Balance, BalanceProvider } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
// 白盒:registry 机制是 @folio/balances 内部件(不对外导出),测试直接引内部模块。
import { buildRegistry, getProvider } from "../src/registry";

function fakeProvider(type: AccountType): BalanceProvider {
  return {
    accountType: type,
    fetchBalances: async () => [],
    validate: async () => true,
  };
}

describe("buildRegistry", () => {
  it("registers each provider under its accountType", () => {
    const reg = buildRegistry([fakeProvider("manual"), fakeProvider("onchain_evm")]);
    expect(reg.manual?.accountType).toBe("manual");
    expect(reg.onchain_evm?.accountType).toBe("onchain_evm");
  });

  it("throws on duplicate account type", () => {
    expect(() => buildRegistry([fakeProvider("manual"), fakeProvider("manual")])).toThrow(
      /Duplicate provider for account type: manual/,
    );
  });

  it("registers multiple provider objects from one multi-type package (方案 A)", () => {
    // coinstats 风格:工厂为每个 type 产出一个 provider 对象,共享内部实现。
    function makeCoinstats(type: AccountType, chain: string): BalanceProvider {
      return {
        accountType: type,
        fetchBalances: async (): Promise<Balance[]> => [
          { symbol: chain, amount: 0, usdValue: 0, source: chain, kind: "spot" },
        ],
        validate: async () => true,
      };
    }
    const coinstats = [
      makeCoinstats("onchain_sui", "sui"),
      makeCoinstats("onchain_cosmos", "cosmos"),
    ];
    // sync 摊平后传入(有的包 1 个、有的多个)。
    const reg = buildRegistry([fakeProvider("onchain_evm"), ...coinstats]);
    expect(reg.onchain_evm).toBeDefined();
    expect(reg.onchain_sui?.accountType).toBe("onchain_sui");
    expect(reg.onchain_cosmos?.accountType).toBe("onchain_cosmos");
  });
});

describe("getProvider", () => {
  it("returns the registered provider", () => {
    const reg = buildRegistry([fakeProvider("manual")]);
    expect(getProvider(reg, "manual").accountType).toBe("manual");
  });

  it("throws when no provider is registered for the type", () => {
    const reg = buildRegistry([]);
    expect(() => getProvider(reg, "exchange_binance")).toThrow(
      /No provider registered for account type: exchange_binance/,
    );
  });
});
