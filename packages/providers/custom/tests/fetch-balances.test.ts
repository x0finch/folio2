import type { Account, FetchContext, ManualData } from "@folio/core";
import { describe, expect, it } from "vitest";
import { customProvider, providers } from "../src";
import fixture from "./fixtures/holdings.json";

const data = fixture as ManualData;

function ctxWith(account: Partial<Account>): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "manual", label: "Manual", ...account },
    creds: {},
    globalKeys: {},
  };
}

describe("customProvider.fetchBalances", () => {
  it("maps manual holdings to Balance[] (kind=manual)", async () => {
    const balances = await customProvider.fetchBalances(ctxWith({ data }));
    expect(balances).toHaveLength(3);
    for (const b of balances) {
      expect(b.kind).toBe("manual");
      expect(b.source).toBe("manual");
    }
    const btc = balances.find((b) => b.symbol === "BTC");
    expect(btc).toEqual({
      symbol: "BTC",
      amount: 0.5,
      usdValue: 32000,
      source: "manual",
      kind: "manual",
    });
    // 非行情资产也照常带过(价值用户录入)
    expect(balances.find((b) => b.symbol === "Gold bar (1oz)")?.usdValue).toBe(5200);
  });

  it("returns [] when there are no holdings", async () => {
    expect(await customProvider.fetchBalances(ctxWith({}))).toEqual([]);
  });

  it("serves accountType 'manual' and is exported in the providers array", () => {
    expect(customProvider.accountType).toBe("manual");
    expect(providers).toContain(customProvider);
  });
});
