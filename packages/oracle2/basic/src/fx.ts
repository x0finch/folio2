// 展示币种(FX)的数据与类型。**存储恒 USD,换算只发生在展示层**(ADR 0006)——
// 所以这一层只有「1 单位该币种值多少美元」这一个数,没有货币对、没有转换方向。
//
// 服务接口(`FxRates`)在 entry:本包只放契约与数据,不放服务(与 `Tokens` / `Mint` 同口径)。

// 展示币种描述符。`code`:fiat = ISO 4217 大写(USD/EUR),crypto = BTC/ETH(非 ISO,自用)。
// `symbol` 只有 crypto 需要 —— fiat 的货币符号由 `Intl` 按 locale 出,写死反而会错。
export interface Currency {
  code: string;
  kind: "fiat" | "crypto";
  symbol?: string;
}

export const DEFAULT_CURRENCY = "USD";

// 支持的展示币种(选择器用;cookie 值按此校验)。十来个主流法币 + BTC/ETH。
// **它是白名单不是全集**:上游能给几百种,但每多一种就多一份要维护的格式化与测试。
export const SUPPORTED_CURRENCIES: readonly Currency[] = [
  { code: "USD", kind: "fiat" },
  { code: "EUR", kind: "fiat" },
  { code: "GBP", kind: "fiat" },
  { code: "JPY", kind: "fiat" },
  { code: "CNY", kind: "fiat" },
  { code: "KRW", kind: "fiat" },
  { code: "HKD", kind: "fiat" },
  { code: "CAD", kind: "fiat" },
  { code: "AUD", kind: "fiat" },
  { code: "CHF", kind: "fiat" },
  { code: "BTC", kind: "crypto", symbol: "₿" },
  { code: "ETH", kind: "crypto", symbol: "Ξ" },
];
