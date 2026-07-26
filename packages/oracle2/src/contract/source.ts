import type { TokenPrice, TokenPricePoint, TokenRef, TokenRefIndexRow } from "./types";

// 上游端口(网络)。沿用现有的**按能力分面**做法(`oracle-basic/src/token.ts` 就是这么分的),
// 并给它加上第三面 —— 全局映射的整份拉取。
//
// **契约层不知道上游是谁**:实现由 app 在初始化时注入(与 store 同款惰性工厂,ADR 0023),
// `dependencies` 里没有任何 client / source 包。所以这里没有 apiKey、没有端点、没有 DTO ——
// 那些都在 `@folio/oracle2-source-coingecko` 里。
// 通用层只说「我们的 chain 标识」;各 source 内部把它翻成自家的寻址命名,不外泄。价格一律 USD。

// 适配器自报的标识,与 `BalanceProvider.id` 同款(小写 slug)。
// 它同时就是本源产出的 tokenRef 的 **namer**,以及全局映射表里的 `namer` 列。
interface SourceIdentity {
  readonly id: string;
}

// 目录 / 发现面:top-N 预热 + 关键词搜索(都需要完整币目录)。
export interface TokenMetaSource extends SourceIdentity {
  // 一行含价 + 涨跌 + rank + name + logo;喂 warm blob。
  fetchMarkets(opts: { topN: number }): Promise<SourceToken[]>;
  // 按关键词搜币(用户选币消歧)。
  searchTokens(query: string): Promise<SourceToken[]>;
}

// 点查面:按已知 ref 刷价 / 取历史 / 按 (chain, contract) 单查。不需要币目录。
export interface PriceSource extends SourceIdentity {
  fetchPrices(refs: readonly TokenRef[]): Promise<Map<TokenRef, TokenPrice>>;
  // 一 ref 一区间**一次**上游调用,升序原始观测点(粒度随上游;按日归一在服务层做)。
  fetchPriceSeries(ref: TokenRef, fromMs: number, toMs: number): Promise<TokenPricePoint[]>;
  // 兜底单查:全局映射里没有的(今天刚上线的币)才走这条。链未收录 / 无此合约 → null。
  fetchByContract(chain: string, contract: string): Promise<SourceToken | null>;
}

// 全局映射面:整份「链上 ref → 本源的叫法」。cron 一天一次(ADR 0022)。
export interface TokenRefIndexSource extends SourceIdentity {
  fetchRefIndex(): Promise<RefIndexFetch>;
}

// 完整代币上游 = 三面之交。当前唯一实现是 CoinGecko adapter。
export type TokenSource = TokenMetaSource & PriceSource & TokenRefIndexSource;

// 上游给出的一个币:它自己的命名 + 元信息 +(可能有的)价。
// 与 `TokenInfo` 的区别:上游结果还没进库,所以没有内部 id、`ref` 必然非空。
export interface SourceToken {
  ref: TokenRef;
  symbol: string;
  name: string;
  logo?: string;
  price?: TokenPrice;
}

// 整份映射的拉取结果。**失配要喊出来**:我们指名要的某条链在上游的平台表里查无此项,
// 后果是那条链上的币全都没价没图**而且不报错** —— 静默故障必须有出口(ADR 0022)。
export interface RefIndexFetch {
  rows: TokenRefIndexRow[];
  unmatchedPlatforms: string[]; // 我们要的链,上游没有 → 告警
  skipped: number; // 上游有、我们不追踪的链 → 纯计数,正常且数目很大
}
