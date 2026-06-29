import type { Fiat, TokenIndex, TokenInfo, TokenPrice, TokenRef } from "./types";

// 可插拔上游(网络)。CoinGecko 是一个实现(`CoinGeckoSource`,P7.2);
// 将来股票是另一个实现 + 另一种 `TokenRef` 变体。三个 fetch* 同口径。
export interface TokenSource {
  // asset_platforms + coins/list?include_platform → 归一索引(EVM 子集)。
  fetchIndex(): Promise<TokenIndex>;
  // coins/markets top-N:一行同时含两facet(价 + 涨跌 + rank + name + logo)。
  fetchMarkets(opts: {
    topN: number;
    vs?: Fiat;
  }): Promise<{ info: TokenInfo; price: TokenPrice }[]>;
  // simple/price 长尾兜底(持有币不在 top-N);返回按 refKey 索引的价。
  fetchPrices(refs: TokenRef[], opts?: { vs?: Fiat }): Promise<Map<string, TokenPrice>>;
}
