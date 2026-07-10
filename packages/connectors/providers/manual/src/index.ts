import type { BalanceProvider, CredField, Spot } from "@folio/connectors-basic";
import { buildTokenKey } from "@folio/tokens-basic";
import { z } from "zod";

// @folio/connectors-provider-manual —— 手动资产(manual connector 的 provider)。无外部 API:一个账户 = 一个手记资产。
// 持仓(symbol/amount/unitPrice + 可选 identifier)全走 account.creds(明文 public:落库、导出原样、可重建);
// fetchBalances map 成单条 kind:"spot" Balance:value = amount × unitPrice、price = unitPrice(P7.4.1)。
// `amount` 由 manual 活动账本(manual_activity)推导后【物化】进 account.creds(app 层);provider 只管读。
// `unitPrice` 用户填(市价自动估值 = P7.4.2);identifier 有则产 coingecko: tokenKey 供 revalue 按显式 ref 解析。
// manual 统一走市价重估(ADR 0010:fixed 已删,spot 零 typed meta);不可解析币回退 amount × unitPrice。
// 零依赖、不碰 SECRETS_KEY/cloudflare:workers(原则 #5)。

// —— 账户级 creds(AC):手记持仓,全 public(明文落库、可导出重建)——
// 账户 creds 声明随 provider(其天然消费者)落此;由 entry 的 manual connector 引入组合。
export const manualAccountCreds = [
  { key: "symbol", type: "public", label: "Symbol", validator: z.string().trim().min(1) },
  { key: "amount", type: "public", label: "Amount", validator: z.coerce.number() },
  { key: "unitPrice", type: "public", label: "Unit price (USD)", validator: z.coerce.number() },
  // 可选:用户选定的 CoinGecko identifier(消歧,P7.4.3)。有则产 tokenKey(coingecko:<id>)
  // 供 sync 期市价重估按显式 ref 解析(见 revalue / resolveAsset 的 coingecko: 直达)。
  { key: "identifier", type: "public", label: "CoinGecko ID", validator: z.string().optional() },
] as const satisfies readonly CredField[];

// 本 connector 只吐单一 kind:spot。无全局/provider key → creds:[]。
export const manualProvider: BalanceProvider<Spot, typeof manualAccountCreds> = {
  id: "manual",
  label: "Manual",
  creds: [],

  async fetchBalances(ctx): Promise<Spot[]> {
    const { symbol, amount, unitPrice, identifier } = ctx.account.creds;
    return [
      {
        symbol,
        amount,
        price: unitPrice,
        value: amount * unitPrice,
        kind: "spot",
        // 用户选定的 CGK id = 厂商寻址身份 → tokenKey(coingecko:<id>),不再塞 meta.identifier;
        // 未选币则无标识,解析时按 symbol 归一(同 CEX)。spot 零 typed meta(ADR 0010)。
        ...(identifier ? { tokenKey: buildTokenKey({ cgkId: identifier }) } : {}),
      },
    ];
  },

  // 无外部源;creds 已由创建流/同步的 validateCredentials(account.creds) 校验过。
  async validateAccount(): Promise<boolean> {
    return true;
  },
};
