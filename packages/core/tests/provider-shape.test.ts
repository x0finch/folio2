import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BalanceProvider } from "../src/provider";

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

  it("can declare inputs with three exposure levels (public/semi/secret; zod validator via Standard Schema)", () => {
    const okxLike: BalanceProvider = {
      accountType: "exchange_okx",
      inputs: [
        { key: "apiKey", type: "semi", label: "API Key", validator: z.string().min(1) },
        { key: "secret", type: "secret", label: "API Secret", validator: z.string().min(1) },
        { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().min(1) },
      ],
      async fetchBalances() {
        return [];
      },
      async validate() {
        return true;
      },
    };
    expect(okxLike.inputs?.map((i) => i.key)).toEqual(["apiKey", "secret", "passphrase"]);
    expect(okxLike.inputs?.map((i) => i.type)).toEqual(["semi", "secret", "secret"]);
    expect(stub.inputs).toBeUndefined(); // 可选,默认无
  });
});
