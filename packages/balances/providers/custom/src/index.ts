import { type Balance, type BalanceProvider, defineProvider } from "@folio/balances-basic";
import { z } from "zod";

// @folio/balances-provider-custom —— 手动资产(manual)。无外部 API:一个账户 = 一个手记资产。
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
    // 可选:用户选定的 CoinGecko identifier(消歧,P7.4.3)。有则透出到 meta 供 sync 期市价重估按显式 ref 解析。
    { key: "identifier", type: "public", label: "CoinGecko ID", validator: z.string().optional() },
    // 可选:锁定固定值(P7.4.4)。在则透出 meta.fixed → sync 期跳过市价重估、钉死 amount × unitPrice。
    // creds 是字符串 map,沿用 identifier 的"在则为真"约定(仅锁定时存 "1")。
    { key: "fixed", type: "public", label: "Lock fixed value", validator: z.string().optional() },
  ],

  async fetchBalances(ctx): Promise<Balance[]> {
    const { symbol, amount, unitPrice, identifier, fixed } = ctx.creds;
    const meta: Record<string, unknown> = {};
    if (identifier) meta.identifier = identifier;
    if (fixed) meta.fixed = true;
    return [
      {
        symbol,
        amount,
        usdValue: amount * unitPrice,
        source: "manual",
        kind: "manual" as const,
        ...(Object.keys(meta).length ? { meta } : {}),
      },
    ];
  },

  // 无外部源;creds 已由 sync/创建流的 validateCredentials(inputs) 校验过。
  async validate(): Promise<boolean> {
    return true;
  },
});

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [customProvider];
