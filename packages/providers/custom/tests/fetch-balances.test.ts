import type { FetchContext } from "@folio/core";
import { describe, expect, it } from "vitest";
import { customProvider, providers } from "../src";

// 一个 manual 账户 = 一个手记资产;持仓走 ctx.creds(symbol/amount/unitPrice,P7.4.1)。
function ctx(creds: Record<string, unknown>): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "manual", label: "Manual" },
    creds,
    globalKeys: {},
  };
}

describe("customProvider.fetchBalances", () => {
  it("maps the single manual holding to one Balance (usdValue = amount × unitPrice)", async () => {
    const balances = await customProvider.fetchBalances(
      ctx({ symbol: "BTC", amount: 0.5, unitPrice: 64000 }),
    );
    expect(balances).toEqual([
      { symbol: "BTC", amount: 0.5, usdValue: 32000, source: "manual", kind: "manual" },
    ]);
  });

  it("serves accountType 'manual' and is exported in the providers array", () => {
    expect(customProvider.accountType).toBe("manual");
    expect(providers).toContain(customProvider);
  });
});
