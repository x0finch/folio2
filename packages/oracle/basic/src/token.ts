import type { TokenInfo, TokenPrice, TokenRef } from "./types";

// 可插拔上游(网络),按能力隔离成两面:
// · TokenMetaSource —— 目录/发现面(top-N 榜单 + 关键词搜索)。需完整币目录,唯身份权威(CoinGecko)实现。
// · PriceSource     —— 点查面(按合约懒解析 / 按已知 ref 刷价)。任何行情源(含只供价的 DefiLlama)都能实现。
// TokenSource = 两面之交,供代币服务(createTokens)消费完整体;单能力源(如 DefiLlama)只实现 PriceSource。
// 「供哪一面」由 vendor 在注册表(VendorImpl)里挂哪个工厂决定 —— 路由据字段在场与否判定,不另存能力集。
// 通用层只说 `chain`(我们的链标识);各 source 内部把 chain 翻译成自己的寻址命名,不外泄。价格一律 USD。

// 目录/发现面:top-N 预热 + 关键词搜索(都需完整币目录)。
export interface TokenMetaSource {
  // 本 source 产出的 `TokenRef` 的 source 标签(如 "coingecko")。store 按它分桶 —— source 是这个值的唯一真相。
  readonly source: TokenRef["source"];
  // coins/markets top-N 预热:一行含价 + 涨跌 + rank + name + logo;info 自带 symbol。
  fetchMarkets(opts: { topN: number }): Promise<{ info: TokenInfo; price: TokenPrice }[]>;
  // 按关键词搜币(用户选币消歧,P7.4.3)。命中即 TokenInfo(ref + name/symbol/logo)。
  searchTokens(query: string): Promise<TokenInfo[]>;
}

// 点查面:按 (chain, contract) 懒解析、或按已知 ref 刷价。只做点查,不需币目录。
export interface PriceSource {
  // 本 source 产出的 `TokenRef` 的 source 标签。
  readonly source: TokenRef["source"];
  // 按 (chain, contract) 懒解析,一次拿 ref+info+price;chain 未收录 / 无此合约 → null。
  fetchByContract(
    chain: string,
    contract: string,
  ): Promise<{ ref: TokenRef; info: TokenInfo; price: TokenPrice } | null>;
  // simple/price 刷新/长尾已知 ref 的价(key=refKey)。
  fetchPrices(refs: TokenRef[]): Promise<Map<string, TokenPrice>>;
}

// 完整代币上游 = 目录面 + 点查面。代币服务(createTokens)消费完整体;平台/汇率面另挂(见 vendor)。
export type TokenSource = TokenMetaSource & PriceSource;
