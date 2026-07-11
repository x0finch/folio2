import { type CredField, Defi, defineConnector, Spot } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRegistry, getConnector, selectProvider } from "../src/registry";

// 就地造一个 spot·defi 子集的示例 connector,验 registry 组装(buildRegistry/getConnector/selectProvider)。
const address = [
  { key: "address", type: "public", validator: z.string().min(1), label: "Address" },
] as const satisfies readonly CredField[];

const evmLike = defineConnector({
  id: "evm-like",
  label: "EVM-like",
  logo: "",
  account: { creds: address },
  balance: {
    schema: z.discriminatedUnion("kind", [Spot, Defi]),
    providers: [
      {
        id: "demo",
        label: "Demo",
        creds: [],
        fetchBalances: async (ctx) => ({
          balances: [
            { kind: "spot", symbol: ctx.account.creds.address, amount: 1, value: 1 },
            { kind: "defi", symbol: "x", amount: 1, value: 1, meta: { protocol: "demo" } },
          ],
        }),
        validateAccount: async () => true,
      },
    ],
  },
});

describe("registry", () => {
  it("buildRegistry 按 id 建表;重复 id 抛错", () => {
    const reg = buildRegistry([evmLike]);
    expect(getConnector(reg, "evm-like")?.id).toBe("evm-like");
    expect(getConnector(reg, "nope")).toBeUndefined();
    expect(() => buildRegistry([evmLike, evmLike])).toThrow(/duplicate/);
  });

  it("selectProvider 取第一个 eligible(defaultEnabled !== false)", () => {
    const providers = evmLike.balance.providers;
    expect(selectProvider(evmLike)?.id).toBe("demo");

    // 构造一个 defaultEnabled:false 在前、true 在后的 manifest,断言跳过被禁用的
    const twoProv = {
      ...evmLike,
      balance: {
        ...evmLike.balance,
        providers: [
          { ...providers[0], id: "off", defaultEnabled: false },
          { ...providers[0], id: "on" },
        ],
      },
    };
    expect(selectProvider(twoProv)?.id).toBe("on");
  });
});
