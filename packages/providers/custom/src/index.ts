import { type Balance, type BalanceProvider, defineProvider } from "@folio/core";
import { z } from "zod";

// @folio/provider-custom —— 手动资产(manual)。无外部 API:一个账户 = 一个手记资产。
// 三个 public 输入(symbol/amount/usdValue)走 creds(明文落库、导出原样、可重建);
// fetchBalances 把它们 map 成单条 Balance。usdValue 用户直接录入(自动定价为后续增强)。
export const customProvider = defineProvider({
  accountType: "manual",
  inputs: [
    { key: "symbol", type: "public", label: "Symbol", validator: z.string().trim().min(1) },
    { key: "amount", type: "public", label: "Amount", validator: z.coerce.number() },
    { key: "usdValue", type: "public", label: "USD Value", validator: z.coerce.number() },
  ],

  async fetchBalances(ctx): Promise<Balance[]> {
    const { symbol, amount, usdValue } = ctx.creds;
    return [{ symbol, amount, usdValue, source: "manual", kind: "manual" as const }];
  },

  // 无外部源;creds 已由 sync/创建流的 validateCredentials(inputs) 校验过。
  async validate(): Promise<boolean> {
    return true;
  },
});

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [customProvider];
