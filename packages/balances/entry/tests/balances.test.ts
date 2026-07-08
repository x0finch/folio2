import type { Account, BalanceProvider } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBalances } from "../src";

// 假 provider(onchain_evm):public identifier + secret token。
// 全局 key 不再经 ctx 下发(ADR 0009:是工厂实例化参数),FetchContext 只有 account/creds。
function fakeProvider(over: Partial<BalanceProvider> = {}): BalanceProvider {
  return {
    accountType: "onchain_evm",
    inputs: [
      { key: "identifier", type: "public", label: "Address", validator: z.string().min(1) },
      { key: "token", type: "secret", label: "Token", validator: z.string().min(1) },
    ],
    validate: async () => true,
    fetchBalances: async () => [],
    ...over,
  };
}
const acc = (): Account => ({ id: "a", userId: "u", type: "onchain_evm", label: "W" });
const mk = (over: Partial<BalanceProvider> = {}) =>
  createBalances({ providers: [fakeProvider(over)] });

describe("createBalances — 只暴露 provider 能力(3 方法)", () => {
  it("credentialSpecs:剥掉 validator 的可序列化字段规格", () => {
    expect(mk().credentialSpecs().onchain_evm).toEqual([
      { key: "identifier", type: "public", label: "Address", desc: undefined },
      { key: "token", type: "secret", label: "Token", desc: undefined },
    ]);
  });

  it("validateCredentials:形状不合规抛;合规过", async () => {
    const b = mk();
    await expect(
      b.validateCredentials({ type: "onchain_evm" }, { identifier: "" }),
    ).rejects.toThrow();
    await expect(
      b.validateCredentials({ type: "onchain_evm" }, { identifier: "0xabc", token: "t" }),
    ).resolves.toBeUndefined();
  });

  it("validateCredentials{liveness}:provider.validate 探活;失败抛", async () => {
    let called = false;
    await mk({
      validate: async () => {
        called = true;
        return true;
      },
    }).validateCredentials(
      { type: "onchain_evm" },
      { identifier: "0xabc", token: "t" },
      { liveness: true },
    );
    expect(called).toBe(true);

    await expect(
      mk({ validate: async () => false }).validateCredentials(
        { type: "onchain_evm" },
        { identifier: "0xabc", token: "t" },
        { liveness: true },
      ),
    ).rejects.toThrow(/could not verify/);
  });

  it("fetchBalances:运行时闸 + 调 provider + 汇总 totalUsd", async () => {
    const b = createBalances({
      providers: [
        fakeProvider({
          fetchBalances: async () => [
            { symbol: "A", amount: 1, value: 10, source: "evm", kind: "spot" },
            { symbol: "B", amount: 1, value: 5, source: "evm", kind: "spot" },
          ],
        }),
      ],
    });
    const out = await b.fetchBalances(acc(), { identifier: "0xabc", token: "t" });
    expect(out.totalUsd).toBe(15);
    // 明文 creds 不合规(缺 token)→ 运行时闸抛。
    await expect(b.fetchBalances(acc(), { identifier: "" })).rejects.toThrow();
  });

  it("resolveProvider 注入:运行时解析生效 provider;undefined → 明确报错(未启用)", async () => {
    const injected = fakeProvider({
      fetchBalances: async () => [
        { symbol: "A", amount: 1, value: 7, source: "evm", kind: "spot" },
      ],
    });
    const b = createBalances({ resolveProvider: async () => injected });
    const out = await b.fetchBalances(acc(), { identifier: "0xabc", token: "t" });
    expect(out.totalUsd).toBe(7);

    const none = createBalances({ resolveProvider: async () => undefined });
    await expect(none.fetchBalances(acc(), { identifier: "0xabc", token: "t" })).rejects.toThrow(
      /No provider enabled/,
    );
  });
});
