// Oracle vendor 抽象(oracle 合包,Phase 1)。一个行情厂商(CoinGecko / CoinMarketCap / DefiLlama)
// 对参考层供哪几类数据,由 `capabilities` 声明。用户选定的「活跃源」+ 活跃源缺某能力时回退 baseline
// 的路由都读它(路由落地见后续切片)。与 `TokenProvider` 解耦——vendor 是「厂商 + 它供的数据类」的
// 元描述,`TokenProvider` 只是其中「代币取数」这一面;将来同一 vendor 还会挂平台/汇率面(#72)。
export type OracleCapability = "prices" | "tokenMeta" | "platformMeta" | "fxRates";

export interface OracleVendor {
  readonly id: string; // 厂商标识,如 "coingecko"(vendor 是这个值的唯一真相)
  readonly capabilities: ReadonlySet<OracleCapability>;
}
