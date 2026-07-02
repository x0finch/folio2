import type { AccountType } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { createBalances } from "../src";

// 锁定各 type 的 inputs(key+type;录入/补录表单、导出剥密钥都依赖它)。经门面 credentialSpecs()(隐藏 registry)。
const specs = createBalances({ globalKeys: {} }).credentialSpecs();

describe("balances.credentialSpecs()", () => {
  const cases: Array<[AccountType, { key: string; type: string }[]]> = [
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
    [
      "manual",
      [
        { key: "symbol", type: "public" },
        { key: "amount", type: "public" },
        { key: "unitPrice", type: "public" },
        { key: "identifier", type: "public" },
        { key: "fixed", type: "public" },
      ],
    ],
  ];
  for (const [type, expected] of cases) {
    it(`${type} inputs → ${JSON.stringify(expected)}`, () => {
      expect((specs[type] ?? []).map((i) => ({ key: i.key, type: i.type }))).toEqual(expected);
    });
  }
});
