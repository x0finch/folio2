import { describe, expect, it } from "vitest";
import type { BalanceProvider } from "../src/provider";

// 最小 stub:验证瘦身后的 BalanceProvider 契约(ADR 0009 层2:纯行为 —— 取数 + 两 liveness,不带身份)。
// accountType 归 manifest;账户输入 schema 归 accountType 层(ACCOUNT_TYPE_SPECS,见 @folio/provider-registry)。
const stub: BalanceProvider = {
  async fetchBalances() {
    return [];
  },
  async validateAccount() {
    return true;
  },
};

describe("BalanceProvider shape", () => {
  it("最小实现:fetchBalances + validateAccount(无 accountType)", async () => {
    const ctx = {
      account: { id: "a1", userId: "u1", type: "manual" as const, label: "Manual" },
      creds: {},
    };
    expect(await stub.fetchBalances(ctx)).toEqual([]);
    expect(await stub.validateAccount(ctx)).toBe(true);
    expect(stub.validateConfig).toBeUndefined(); // 可选:无全局 config 的 provider 不声明
  });

  it("可声明 validateConfig(输入4:全局 config liveness)", async () => {
    const withConfig: BalanceProvider = {
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
