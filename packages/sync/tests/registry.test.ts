import { getProvider } from "@folio/core";
import { describe, expect, it } from "vitest";
import { appRegistry } from "../src/registry";

// 锁定各 type 的 inputs(key+type;录入/补录表单、导出剥密钥都依赖它)。
describe("appRegistry inputs", () => {
  const cases: Array<[Parameters<typeof getProvider>[1], { key: string; type: string }[]]> = [
    ["onchain_evm", [{ key: "identifier", type: "public" }]],
    ["onchain_solana", [{ key: "identifier", type: "public" }]],
    ["perp_hyperliquid", [{ key: "identifier", type: "public" }]],
    [
      "exchange_binance",
      [
        { key: "apiKey", type: "semi" },
        { key: "secret", type: "secret" },
      ],
    ],
    [
      "exchange_okx",
      [
        { key: "apiKey", type: "semi" },
        { key: "secret", type: "secret" },
        { key: "passphrase", type: "secret" },
      ],
    ],
    ["manual", []],
  ];
  for (const [type, expected] of cases) {
    it(`${type} inputs → ${JSON.stringify(expected)}`, () => {
      const inputs = getProvider(appRegistry, type).inputs ?? [];
      expect(inputs.map((i) => ({ key: i.key, type: i.type }))).toEqual(expected);
    });
  }
});
