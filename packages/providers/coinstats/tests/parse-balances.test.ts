import { describe, expect, it } from "vitest";
import { parseBalances } from "../src";
import fixture from "./fixtures/balances.json";

// fixture = 录制的真实 wallet/balance 响应(解析器输入)。本测试把整份解析结果一次性钉成
// golden(toEqual),覆盖:usdValue=amount*price、kind=spot、链无关映射(Solana/Sui/Cosmos)、
// 每条 coin 自带 chain/connectionId、null price→0、null contractAddress→undefined、跳过无 symbol。
// 非整数乘积(CT/ATOM)用与实现相同的表达式书写,确保浮点位级相等。
describe("parseBalances (golden)", () => {
  const balances = parseBalances(fixture, "solana");

  it("maps the recorded response to the expected Balance[]", () => {
    expect(balances).toEqual([
      {
        symbol: "SOL",
        amount: 12.5,
        usdValue: 1875,
        source: "solana",
        kind: "spot",
        meta: { chain: "solana", connectionId: "solana", contractAddress: undefined },
      },
      {
        symbol: "USDC",
        amount: 500,
        usdValue: 500,
        source: "solana",
        kind: "spot",
        meta: {
          chain: "solana",
          connectionId: "solana",
          contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      },
      {
        symbol: "CT",
        amount: 1010,
        usdValue: 1010 * 0.00001,
        source: "solana",
        kind: "spot",
        meta: {
          chain: "solana",
          connectionId: "solana",
          contractAddress: "6fUwECXzRQeh2wYuTg3xeQHGt4wSbiUbsdd1PYw3pump",
        },
      },
      {
        symbol: "UNP",
        amount: 100,
        usdValue: 0,
        source: "solana",
        kind: "spot",
        meta: {
          chain: "solana",
          connectionId: "solana",
          contractAddress: "Unpriced11111111111111111111111111111111111",
        },
      },
      {
        symbol: "SUI",
        amount: 40,
        usdValue: 140,
        source: "sui",
        kind: "spot",
        meta: { chain: "sui", connectionId: "sui-wallet", contractAddress: undefined },
      },
      {
        symbol: "ATOM",
        amount: 105.29550851642641,
        usdValue: 105.29550851642641 * 1.592410066278476,
        source: "cosmos",
        kind: "spot",
        meta: { chain: "cosmos", connectionId: "cosmos", contractAddress: "uatom" },
      },
    ]);
  });

  it("excludes the no-symbol entry", () => {
    // fixture 有 7 条,其中 1 条 symbol 为空 → 解析结果 6 条,且无空 symbol。
    expect(balances).toHaveLength(6);
    expect(balances.every((b) => b.symbol.length > 0)).toBe(true);
  });
});
