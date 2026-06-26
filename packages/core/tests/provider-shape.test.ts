import { describe, expect, it } from "vitest";
import type { BalanceProvider, CredentialFlags } from "../src/provider";
import type { AccountWithFlags } from "../src/types";

// 最小 stub:验证 BalanceProvider 接口形状可被实现(类型标注在编译期校验)。
const stub: BalanceProvider = {
  accountType: "manual",
  async fetchBalances() {
    return [];
  },
  async validate() {
    return true;
  },
};

describe("BalanceProvider shape", () => {
  it("can be implemented by a minimal stub", async () => {
    const ctx = {
      account: { id: "a1", userId: "u1", type: "manual" as const, label: "Manual" },
      creds: {},
      globalKeys: {},
    };
    expect(stub.accountType).toBe("manual");
    expect(stub.usesGlobalKeys).toBeUndefined(); // 可选,默认无(不需要任何全局 key)
    expect(await stub.fetchBalances(ctx)).toEqual([]);
    expect(await stub.validate(ctx)).toBe(true);
  });

  it("can declare usesGlobalKeys (least-privilege scope of global keys)", () => {
    const scoped: BalanceProvider = {
      accountType: "onchain_evm",
      usesGlobalKeys: ["ZERION_API_KEY"],
      async fetchBalances() {
        return [];
      },
      async validate() {
        return true;
      },
    };
    expect(scoped.usesGlobalKeys).toEqual(["ZERION_API_KEY"]);
  });

  it("derives has* flags from ProviderCredentials (编译期 + 运行期)", () => {
    // 编译期:这些 key 必须正好是 CredentialFlags 推导出的形状,写错则 tsc 报错。
    const flags: CredentialFlags = {
      hasApiKey: true,
      hasSecret: false,
      hasPassphrase: true,
      hasIdentifier: false,
    };
    // 运行期:AccountWithFlags = Account + 推导的 has* 标志。
    const account: AccountWithFlags = {
      id: "a1",
      userId: "u1",
      type: "manual",
      label: "Manual wallet",
      hasApiKey: true,
    };
    expect(flags.hasApiKey).toBe(true);
    expect(account.hasApiKey).toBe(true);
  });
});
