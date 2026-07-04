import type { Account, BalanceProvider } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBalances } from "../src";

const globalKeys = { ZERION_API_KEY: "zk", OTHER: "x" };

// 假 provider(onchain_evm):public identifier + secret token;声明只用 ZERION_API_KEY。
function fakeProvider(over: Partial<BalanceProvider> = {}): BalanceProvider {
  return {
    accountType: "onchain_evm",
    usesGlobalKeys: ["ZERION_API_KEY"],
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
  createBalances({ globalKeys, providers: [fakeProvider(over)] });

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

  it("validateCredentials{liveness}:按 usesGlobalKeys 收窄全局 key + provider.validate;失败抛", async () => {
    let seen: Record<string, string> | undefined;
    await mk({
      validate: async (ctx) => {
        seen = ctx.globalKeys;
        return true;
      },
    }).validateCredentials(
      { type: "onchain_evm" },
      { identifier: "0xabc", token: "t" },
      { liveness: true },
    );
    expect(seen).toEqual({ ZERION_API_KEY: "zk" }); // 拿不到 OTHER

    await expect(
      mk({ validate: async () => false }).validateCredentials(
        { type: "onchain_evm" },
        { identifier: "0xabc", token: "t" },
        { liveness: true },
      ),
    ).rejects.toThrow(/could not verify/);
  });

  it("fetchBalances:运行时闸 + 收窄 key + 调 provider + 汇总 totalUsd", async () => {
    let seen: Record<string, string> | undefined;
    const b = createBalances({
      globalKeys,
      providers: [
        fakeProvider({
          fetchBalances: async (ctx) => {
            seen = ctx.globalKeys;
            return [
              { symbol: "A", amount: 1, value: 10, source: "evm", kind: "spot" },
              { symbol: "B", amount: 1, value: 5, source: "evm", kind: "spot" },
            ];
          },
        }),
      ],
    });
    const out = await b.fetchBalances(acc(), { identifier: "0xabc", token: "t" });
    expect(out.totalUsd).toBe(15);
    expect(seen).toEqual({ ZERION_API_KEY: "zk" });
    // 明文 creds 不合规(缺 token)→ 运行时闸抛。
    await expect(b.fetchBalances(acc(), { identifier: "" })).rejects.toThrow();
  });
});
