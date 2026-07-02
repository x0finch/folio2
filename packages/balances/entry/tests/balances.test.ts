import type { Account, BalanceProvider } from "@folio/balances-basic";
import { generateSecret, sealCreds } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBalances } from "../src";

const secretsKey = generateSecret();
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
  createBalances({ secretsKey, globalKeys, providers: [fakeProvider(over)] });

describe("createBalances — 隐藏 provider/creds 原语,只暴露意图", () => {
  it("needsCredentials:缺 secret 字段 → true;齐全 → false", () => {
    expect(mk().needsCredentials("onchain_evm", { identifier: "0xabc" })).toBe(true);
    expect(mk().needsCredentials("onchain_evm", { identifier: "0xabc", token: "enc" })).toBe(false);
  });

  it("safeCredentials:丢 secret、留 public", () => {
    const safe = mk().safeCredentials("onchain_evm", { identifier: "0xabc", token: "enc" });
    expect(safe).not.toHaveProperty("token");
    expect(safe.identifier).toBe("0xabc");
  });

  it("prepareCredentials:校验闸(非法抛)+ 封装(public 明文 / secret 密文)", async () => {
    const b = mk();
    await expect(
      b.prepareCredentials({ type: "onchain_evm", label: "W" }, { identifier: "", token: "t" }),
    ).rejects.toThrow();
    const map = JSON.parse(
      await b.prepareCredentials(
        { type: "onchain_evm", label: "W" },
        { identifier: "0xabc", token: "t" },
      ),
    );
    expect(map.identifier).toBe("0xabc"); // public 明文
    expect(map.token).not.toBe("t"); // secret 已加密
  });

  it("prepareCredentials{verify}:按 usesGlobalKeys 收窄全局 key + provider.validate;失败抛", async () => {
    let seen: Record<string, string> | undefined;
    const b = mk({
      validate: async (ctx) => {
        seen = ctx.globalKeys;
        return true;
      },
    });
    await b.prepareCredentials(
      { type: "onchain_evm", label: "W" },
      { identifier: "0xabc", token: "t" },
      { verify: true },
    );
    expect(seen).toEqual({ ZERION_API_KEY: "zk" }); // 拿不到 OTHER
    // 活性失败 → 抛(不封装)。
    await expect(
      mk({ validate: async () => false }).prepareCredentials(
        { type: "onchain_evm", label: "W" },
        { identifier: "0xabc", token: "t" },
        { verify: true },
      ),
    ).rejects.toThrow(/could not verify/);
  });

  it("fetchBalances:缺凭据 → needs-credentials(不取数)", async () => {
    expect(await mk().fetchBalances(acc(), { identifier: "0xabc" })).toEqual({
      status: "needs-credentials",
    });
  });

  it("fetchBalances:解密 + 收窄 key + 调 provider + 汇总 totalUsd", async () => {
    let seen: Record<string, string> | undefined;
    const provider = fakeProvider({
      fetchBalances: async (ctx) => {
        seen = ctx.globalKeys;
        return [
          { symbol: "A", amount: 1, usdValue: 10, source: "evm", kind: "spot" },
          { symbol: "B", amount: 1, usdValue: 5, source: "evm", kind: "spot" },
        ];
      },
    });
    const b = createBalances({ secretsKey, globalKeys, providers: [provider] });
    // 用同一 secretsKey 封装 stored(含加密 token),模拟落库形态。
    const stored = await sealCreds(
      provider.inputs ?? [],
      { identifier: "0xabc", token: "t" },
      secretsKey,
    );
    const out = await b.fetchBalances(acc(), stored);
    expect(out).toMatchObject({ status: "ok", totalUsd: 15 });
    expect(seen).toEqual({ ZERION_API_KEY: "zk" });
  });
});
