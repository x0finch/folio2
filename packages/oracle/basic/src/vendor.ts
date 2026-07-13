// Oracle vendor 抽象(oracle 合包,Phase 1)。一个行情厂商(CoinGecko / CoinMarketCap / DefiLlama)
// 是「厂商身份」的元描述。它对参考层供哪几类数据,不再由独立的能力集声明,而是由注册表里挂了哪些
// 实现工厂(VendorImpl 的 tokenMetaSource / priceSource / platformSource / fxSource)决定 —— 路由据
// 「字段在场与否」判定,避免能力集与实现两处真相不一致。`OracleCapability` 仍是路由词汇(见 pickVendor)。
export type OracleCapability = "prices" | "tokenMeta" | "platformMeta" | "fxRates";

export interface OracleVendor {
  readonly id: string; // 厂商标识,如 "coingecko"(vendor 是这个值的唯一真相)
}
