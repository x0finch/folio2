import type { TokenInfo, TokenPrice, TokenRef } from "./types";

// 可插拔上游(网络)。CoinGecko 是一个实现;将来股票是另一个实现。
// 策略:top-N 预热(主流币的 symbol/价/元信息)+ 按需懒解析(链上合约首见时取一次)。
// 通用层只说 `chain`(我们的链标识);各 provider 内部把 chain 翻译成自己的寻址命名,不外泄。
// 价格一律 USD(多法币用汇率在展示层换算)。
export interface TokenProvider {
  // 本 provider 产出的 `TokenRef` 的 source 标签(如 "coingecko")。store 按它分桶 —— provider 是这个值的唯一真相。
  readonly source: TokenRef["source"];
  // coins/markets top-N 预热:一行含两facet(价 + 涨跌 + rank + name + logo;info 自带 symbol)。
  fetchMarkets(opts: { topN: number }): Promise<{ info: TokenInfo; price: TokenPrice }[]>;
  // 按 (chain, contract) 懒解析,一次拿 ref+info+price;chain 未收录 / 无此合约 → null。
  fetchByContract(
    chain: string,
    contract: string,
  ): Promise<{ ref: TokenRef; info: TokenInfo; price: TokenPrice } | null>;
  // simple/price 刷新/长尾已知 ref 的价(key=refKey)。
  fetchPrices(refs: TokenRef[]): Promise<Map<string, TokenPrice>>;
  // 按关键词搜币(用户选币消歧,P7.4.3)。命中即 TokenInfo(ref + name/symbol/logo)。
  searchTokens(query: string): Promise<TokenInfo[]>;
}
