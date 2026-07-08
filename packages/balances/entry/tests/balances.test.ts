import type { Account, BalanceProvider } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { createBalances } from "../src";

// 账户输入 schema 归 accountType 层(ACCOUNT_TYPE_SPECS);provider 只提供取数 + liveness。
// 假 provider 服务 onchain_evm(层1 输入 = [identifier])。
function fakeProvider(over: Partial<BalanceProvider> = {}): BalanceProvider {
  return {
    validateAccount: async () => true,
    fetchBalances: async () => [],
    ...over,
  };
}
const acc = (): Account => ({ id: "a", userId: "u", type: "onchain_evm", label: "W" });
const mk = (over: Partial<BalanceProvider> = {}) =>
  createBalances({ registry: { onchain_evm: fakeProvider(over) } });

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("createBalances — 账户输入来自 accountType 层", () => {
  it("credentialSpecs:来自 ACCOUNT_TYPE_SPECS(与 provider 无关)", () => {
    const specs = mk().credentialSpecs();
    expect(specs.onchain_evm).toEqual([
      { key: "identifier", type: "public", label: "EVM Address", desc: "0x + 40 hex" },
    ]);
    // 全类型都在(不受注入的单个 provider 限制)。
    expect(specs.manual?.map((s) => s.key)).toEqual([
      "symbol",
      "amount",
      "unitPrice",
      "identifier",
      "fixed",
    ]);
  });

  it("validateCredentials:形状不合规抛;合规过(用层1 的 EVM validator)", async () => {
    const b = mk();
    await expect(
      b.validateCredentials({ type: "onchain_evm" }, { identifier: "x" }),
    ).rejects.toThrow();
    await expect(
      b.validateCredentials({ type: "onchain_evm" }, { identifier: EVM }),
    ).resolves.toBeUndefined();
  });

  it("validateCredentials{liveness}:调 provider.validateAccount;失败抛", async () => {
    let called = false;
    await mk({
      validateAccount: async () => {
        called = true;
        return true;
      },
    }).validateCredentials({ type: "onchain_evm" }, { identifier: EVM }, { liveness: true });
    expect(called).toBe(true);

    await expect(
      mk({ validateAccount: async () => false }).validateCredentials(
        { type: "onchain_evm" },
        { identifier: EVM },
        { liveness: true },
      ),
    ).rejects.toThrow(/could not verify/);
  });

  it("validateProviderConfig(输入4 liveness):validateConfig=false → 抛;无则略过", async () => {
    const b = mk();
    await expect(
      b.validateProviderConfig(fakeProvider({ validateConfig: async () => false })),
    ).rejects.toThrow(/could not verify this API key/);
    await expect(
      b.validateProviderConfig(fakeProvider({ validateConfig: async () => true })),
    ).resolves.toBeUndefined();
    await expect(b.validateProviderConfig(fakeProvider())).resolves.toBeUndefined(); // 无 validateConfig
  });

  it("fetchBalances:运行时闸 + 调 provider + 汇总 totalUsd", async () => {
    const b = createBalances({
      registry: {
        onchain_evm: fakeProvider({
          fetchBalances: async () => [
            { symbol: "A", amount: 1, value: 10, kind: "spot" },
            { symbol: "B", amount: 1, value: 5, kind: "spot" },
          ],
        }),
      },
    });
    const out = await b.fetchBalances(acc(), { identifier: EVM });
    expect(out.totalUsd).toBe(15);
    await expect(b.fetchBalances(acc(), { identifier: "bad" })).rejects.toThrow();
  });

  it("resolveProvider 注入:运行时解析生效 provider;undefined → 明确报错(未启用)", async () => {
    const injected = fakeProvider({
      fetchBalances: async () => [{ symbol: "A", amount: 1, value: 7, kind: "spot" }],
    });
    const b = createBalances({ resolveProvider: async () => injected });
    expect((await b.fetchBalances(acc(), { identifier: EVM })).totalUsd).toBe(7);

    const none = createBalances({ resolveProvider: async () => undefined });
    await expect(none.fetchBalances(acc(), { identifier: EVM })).rejects.toThrow(
      /No provider enabled/,
    );
  });
});
