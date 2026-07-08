import { describe, expect, it } from "vitest";
import type { BalanceProvider } from "../src/provider";

// 最小 stub:验证瘦身后的 BalanceProvider 契约可被实现(ADR 0009 层2:只管取数 + 两 liveness)。
// 账户输入 schema 归 accountType 层(ACCOUNT_TYPE_SPECS,见 @folio/provider-registry),不在 provider 上。
const stub: BalanceProvider = {
  accountType: "manual",
  async fetchBalances() {
    return [];
  },
  async validateAccount() {
    return true;
  },
};

describe("BalanceProvider shape", () => {
  it("最小实现:accountType + fetchBalances + validateAccount", async () => {
    const ctx = {
      account: { id: "a1", userId: "u1", type: "manual" as const, label: "Manual" },
      creds: {},
    };
    expect(stub.accountType).toBe("manual");
    expect(await stub.fetchBalances(ctx)).toEqual([]);
    expect(await stub.validateAccount(ctx)).toBe(true);
    expect(stub.validateConfig).toBeUndefined(); // 可选:无全局 config 的 provider 不声明
  });

  it("可声明 validateConfig(输入4:全局 config liveness)", async () => {
    const withConfig: BalanceProvider = {
      accountType: "onchain_evm",
      async fetchBalances() {
        return [];
      },
      async validateAccount() {
        return true;
      },
      async validateConfig() {
        return true;
      },
    };
    expect(await withConfig.validateConfig?.()).toBe(true);
  });
});
