import type { Balance, BalanceProvider, FetchContext, ManualData } from "@folio/core";

// @folio/provider-custom —— 手动资产(manual)。无外部 API:持仓由用户录入,
// 经 account.data.holdings 传入(落库时加密,sync 解密后组进 FetchContext)。
// usdValue 用户直接录入(自动定价为后续增强)。

function isValidHolding(h: unknown): boolean {
  if (typeof h !== "object" || h === null) return false;
  const { symbol, amount, usdValue } = h as Record<string, unknown>;
  return (
    typeof symbol === "string" &&
    symbol.trim().length > 0 &&
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    typeof usdValue === "number" &&
    Number.isFinite(usdValue)
  );
}

export const customProvider: BalanceProvider = {
  accountType: "manual",

  async fetchBalances(ctx: FetchContext): Promise<Balance[]> {
    const holdings = (ctx.account.data as ManualData | undefined)?.holdings ?? [];
    return holdings.map((h) => ({
      symbol: h.symbol,
      amount: h.amount,
      usdValue: h.usdValue,
      source: "manual",
      kind: "manual",
    }));
  },

  async validate(ctx: FetchContext): Promise<boolean> {
    const holdings = (ctx.account.data as ManualData | undefined)?.holdings;
    if (!Array.isArray(holdings) || holdings.length === 0) return false;
    return holdings.every(isValidHolding);
  },
};

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [customProvider];
