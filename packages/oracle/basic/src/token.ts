import type { TokenInfo, TokenPrice, TokenPricePoint, TokenRef } from "./types";

// 可插拔上游(网络),按能力隔离成两面(便于将来接只供价 / 只供目录的源):
// · TokenMetaSource —— 目录/发现面(top-N 榜单 + 关键词搜索)。需完整币目录,唯身份权威(CoinGecko)实现。
// · PriceSource     —— 点查面(按合约懒解析 / 按已知 ref 刷价)。
// TokenSource = 两面之交,供代币服务(createTokens)消费完整体。当前 CoinGecko 实现完整体。
// 通用层只说 `chain`(我们的链标识);各 source 内部把 chain 翻译成自己的寻址命名,不外泄。价格一律 USD。

// 目录/发现面:top-N 预热 + 关键词搜索(都需完整币目录)。
export interface TokenMetaSource {
  // 本 source 的标识(如 "coingecko"),与 `BalanceProvider.id` 同款:适配器用小写 slug 标识自己。
  // store 按它分桶,它也是本源产出的 tokenRef 的左段。不叫 `name` —— 本仓 `name` 一律是展示名。
  readonly id: string;
  // coins/markets top-N 预热:一行含价 + 涨跌 + rank + name + logo;info 自带 symbol。
  fetchMarkets(opts: { topN: number }): Promise<{ info: TokenInfo; price: TokenPrice }[]>;
  // 按关键词搜币(用户选币消歧,P7.4.3)。命中即 TokenInfo(ref + name/symbol/logo)。
  searchTokens(query: string): Promise<TokenInfo[]>;
}

// 点查面:按 (chain, contract) 懒解析、或按已知 ref 刷价。只做点查,不需币目录。
export interface PriceSource {
  // 本 source 的标识(见上)。
  readonly id: string;
  // 按 (chain, contract) 懒解析,一次拿 ref+info+price;chain 未收录 / 无此合约 → null。
  fetchByContract(
    chain: string,
    contract: string,
  ): Promise<{ ref: TokenRef; info: TokenInfo; price: TokenPrice } | null>;
  // simple/price 刷新/长尾已知 ref 的价(key = tokenRef 串本身)。
  fetchPrices(refs: TokenRef[]): Promise<Map<string, TokenPrice>>;
  // 历史价序列:一 ref 一区间**一次**上游调用,升序原始观测点(USD)。非本源 / 无历史 → 空。
  // 粒度由上游定(CoinGecko:>90d 日级、≤90d 小时级);按日归一在 tokens 服务侧做。
  fetchPriceSeries(ref: TokenRef, fromMs: number, toMs: number): Promise<TokenPricePoint[]>;
}

// 完整代币上游 = 目录面 + 点查面。代币服务(createTokens)消费完整体;平台/汇率面另挂(见 vendor)。
export type TokenSource = TokenMetaSource & PriceSource;
