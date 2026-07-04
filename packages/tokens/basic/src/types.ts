// 代币参考层的领域类型。命名规则(单一,贯穿全包):
//   · `asset` = 持仓侧的【输入】(从 Balance 抽出的待解析身份,可能解析不出) —— 仅 `AssetRef`。
//   · `token` = 参考层的一切(解析后的规范实体及其数据/接口) —— `TokenRef`/`TokenInfo`/…。
//   · `coin`  = 只保留在 CoinGecko 包内部(局部变量 / `CoinGeckoConfig` / "CoinGecko ID" 文案);
//     通用契约一律用 `token`,`TokenRef.identifier` 承载上游 id(具体是不是 coin 由 source 决定)。
// 通用契约不出现 `coin`;`resolve.ts` 全程认 `TokenRef`,加新 provider 零返工。

// 上游代币 id —— 品牌类型,防与裸 string / 其它 id(symbol/contract/chain)混用。
// 仅用于下面的 `TokenRef.identifier`;通过 `as CgkCoinId` 在可信边界(解析上游响应)构造。
export type CgkCoinId = string & { readonly __brand: "CgkCoinId" };

// 解析【输出】:带 source 标签的规范引用。判别联合 —— 将来加股票 = 新增 `{ source:"equity"; … }`,
// 存储/富化 seam 不返工。
export type TokenRef = { source: "coingecko"; identifier: CgkCoinId };

// 解析【输入】(持仓侧;由调用方从 Balance 抽取)。
// `ref` = 已知解析(命中则直接升格,跳过查找);`identifier` = 用户显式选定的上游 id(如选币),
// tokens 层据它造 ref —— 调用方无需知道 source / 自己拼 TokenRef。
export interface AssetRef {
  symbol: string;
  tokenIdentifier?: string; // 已构造的 CAIP-19 标识(持仓侧持久化);解析优先用它(impl key + 懒解析原料)
  ref?: TokenRef;
  identifier?: string; // 用户显式选定的上游 id(选币)
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
// `unitPrice`/`change24h` 一律以 **USD** 计价;多法币在展示层用 USD→法币汇率换算(P8.6),不进本层。
export interface TokenPrice {
  ref: TokenRef;
  unitPrice: number;
  change24h?: number;
  marketCapRank?: number;
  asOf: number;
}

// —— 符号消歧的候选(瞬时,喂 `pickByConfidence`)——
// 来自 warm(top-N markets),已带 `marketCapRank`;symbol 是 store 的 key,值里不带。
export interface TokenCandidate {
  ref: TokenRef;
  marketCapRank?: number;
}

// —— 代币表整行读出(store 的统一读单元)——
// 价格 SWR:过期不删、读出带 stale 标(展示先给旧价,调用方后台刷新)。
export interface TokenRecordPrice {
  unitPrice: number;
  change24h?: number;
  asOf: number;
  stale: boolean; // price_expires_at < now
}

// 代币表一行:CGK 收录币(ref 非空)或 provider 孤儿(CGK 未收录/未解析,ref 为 null)。
// logo = CGK(canonical);providerLogo = provider 自带备用槽(孤儿的主图;CGK 缺图时兜底)。
export interface TokenRecord {
  id: string;
  ref: TokenRef | null;
  symbol: string;
  name: string;
  logo?: string;
  providerLogo?: string;
  marketCapRank?: number;
  price?: TokenRecordPrice;
}

// provider 侧 seed(同步时采集):孤儿建行/已有行刷新 providerLogo 用。
export interface ProviderTokenSeed {
  symbol: string; // 已归一(大写)
  name?: string;
  providerLogo?: string;
}
