// 代币参考层的领域类型。命名规则(单一,贯穿全包):
//   · `asset` = 持仓侧的【输入】(从 Balance 抽出的待解析身份,可能解析不出) —— 仅 `AssetRef`。
//   · `token` = 参考层的一切(解析后的规范实体及其数据/接口) —— `TokenRef`/`TokenInfo`/…。
//   · `coin`  = 仅 CoinGecko 角落 —— `CoinId`,只活在 `TokenRef` 的 coingecko 变体里。
// 通用契约不出现 `coin`;`resolve.ts` 全程认 `TokenRef`,加新 source 零返工。

// 法币计价单位。P8.6 多法币时扩;现仅 usd,但 `vs` 字段已留,后续不破契约。
export type Fiat = "usd";

// CoinGecko 的 coin-id —— 品牌类型,防与裸 string / 其它 id(symbol/contract/platform)混用。
// 仅用于下面的 coingecko `TokenRef` 变体;通过 `as CoinId` 在可信边界(解析 CGK 响应)构造。
export type CoinId = string & { readonly __brand: "CoinId" };

// 解析【输出】:带 source 标签的规范引用。判别联合 —— 将来加股票 = 新增 `{ source:"equity"; … }`,
// 存储/富化 seam 不返工。
export type TokenRef = { source: "coingecko"; coinId: CoinId };

// 解析【输入】(持仓侧;由调用方从 Balance 抽取)。
// `ref` = 已知解析(如 manual 资产用户显式选定的币),命中则直接升格,跳过查找。
export interface AssetRef {
  symbol: string;
  chain?: string;
  contract?: string;
  ref?: TokenRef;
}

export type Confidence = "high" | "low";
export type ResolutionVia = "explicit" | "contract" | "override" | "symbol" | "none";

// 解析结果。`ref:null` = 无法定价(调用方走 provider 回退);`confidence:"low"` = 调用方应降级,不写进数据。
export interface Resolution {
  ref: TokenRef | null;
  confidence: Confidence;
  via: ResolutionVia;
}

// —— 缓存里【存储】的两个facet(分开 = 不同 TTL)——
// 元信息facet,慢 TTL(logo/name 极少变,没必要随价刷)。
export interface TokenInfo {
  ref: TokenRef;
  symbol: string;
  name: string;
  logo?: string;
}

// 价facet,快 TTL。`marketCapRank` 是市场数据,其权威 home 在此。
export interface TokenPrice {
  ref: TokenRef;
  unitPrice: number;
  change24h?: number;
  marketCapRank?: number;
  vs: Fiat;
  asOf: number;
}

// —— 解析【过程】类型(瞬时,不进缓存)——
// 喂 `pickByConfidence`;symbol 是 `TokenIndex.bySymbol` 的 key,值里不带。
// rank 在建索引/灌 markets 时合并好(P7.2/P7.3),`resolve` 拿到的候选已带 rank。
export interface TokenCandidate {
  ref: TokenRef;
  marketCapRank?: number;
}

// 解析索引(慢变)。键归一见 resolve.ts(`byContract`=`platform:contractLower`、`bySymbol`=normalizeSymbol)。
// 序列化/落库细节留 P7.3。
export interface TokenIndex {
  byContract: Map<string, TokenRef>;
  bySymbol: Map<string, TokenCandidate[]>;
  platforms: Map<string, string>; // 我们的 chain 键(小写)→ CoinGecko 平台 id
  asOf: number;
}
