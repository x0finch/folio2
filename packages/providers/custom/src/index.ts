import { type Balance, type BalanceProvider, defineProvider } from "@folio/core";
import { z } from "zod";

// @folio/provider-custom —— 手动资产(manual)。无外部 API:一个账户 = 一个手记资产。
// 三个 public 输入(symbol/amount/unitPrice)走 creds(明文落库、导出原样、可重建);
// fetchBalances map 成单条 Balance:usdValue = amount × unitPrice(P7.4.1)。
// `amount` 由 manual 活动账本(manual_activity)推导后【物化】进 creds(见 web server fn);provider 只管读。
// `unitPrice` 用户填(市价自动估值 = P7.4.2)。
export const customProvider = defineProvider({
  accountType: "manual",
  inputs: [
    { key: "symbol", type: "public", label: "Symbol", validator: z.string().trim().min(1) },
    { key: "amount", type: "public", label: "Amount", validator: z.coerce.number() },
    { key: "unitPrice", type: "public", label: "Unit price (USD)", validator: z.coerce.number() },
  ],

  async fetchBalances(ctx): Promise<Balance[]> {
    const { symbol, amount, unitPrice } = ctx.creds;
    return [
      { symbol, amount, usdValue: amount * unitPrice, source: "manual", kind: "manual" as const },
    ];
  },

  // 无外部源;creds 已由 sync/创建流的 validateCredentials(inputs) 校验过。
  async validate(): Promise<boolean> {
    return true;
  },
});

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [customProvider];
