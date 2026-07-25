import type { TokenRef } from "@folio/oracle-ref";

// 代币参考层的领域类型。命名规则(单一,贯穿全包):
//   · `asset` = 持仓侧的【输入】(从 Balance 抽出的待解析身份,可能解析不出) —— 仅 `AssetRef`。
//   · `token` = 参考层的一切(解析后的规范实体及其数据/接口) —— `TokenRef`(串)/`TokenInfo`/…。
//   · `coin`  = 只保留在 CoinGecko 包内部(局部变量 / `CoinGeckoConfig` / "CoinGecko ID" 文案);
//     通用契约一律用 `token`;上游 id 由 tokenRef 的 localName 承载(是不是 coin 由命名者决定)。
// 通用契约不出现 `coin`;`resolve.ts` 全程认 `TokenRef`,加新 source 零返工。

export type { TokenRef };

// 解析【输出】= 一条 tokenRef 串(ADR 0020)。以前这里是 `{ source; identifier }` 判别联合,
// 与 tokenRef 是同一件事的两种写法(`refKey` 产的 `coingecko:x` 和 `tokenRef` 的 `coingecko/x`
// 只差一个斜杠)→ 已溶解成串。加新源不需要改类型:换个命名者即可(`coinmarketcap/1027`)。

// 解析【输入】(持仓侧;由调用方从 Balance 抽取)。
// `ref` = 已知解析(命中则直接升格,跳过查找);`identifier` = 用户显式选定的上游 id(如选币),
// tokens 层据它造 ref —— 调用方无需知道 source / 自己拼 TokenRef。
// 持仓侧交来的待解析身份。`tokenRef` 与 Balance 上的同名字段是同一个值 —— 不换名字。
// `identifier` 是用户显式选中的上游 id(选币):调用方给 id 即可,由 tokens 层配上当前命名者造 ref,
// 因此调用方不必知道当前是哪家 vendor。
export interface AssetRef {
  symbol: string;
  tokenRef?: TokenRef;
  identifier?: string;
}

// 门面内部形:`ref` = 已定的规范身份(命中则直接升格,跳过查找)。
// 只由 `createTokens` 从 `identifier` 填,外部调用方**不设**此字段 —— 故不进公开的 AssetRef。
export type ResolvableAsset = AssetRef & { ref?: TokenRef };

export type Confidence = "high" | "low";
export type ResolutionVia = "explicit" | "contract" | "override" | "symbol" | "none";

// 解析结果。`ref:null` = 无法定价(调用方走 source 回退);`confidence:"low"` = 调用方应降级,不写进数据。
export interface Resolution {
  ref: TokenRef | null;
  confidence: Confidence;
  via: ResolutionVia;
}

// —— 缓存里【存储】的两个facet(分开 = 不同 TTL)——
// 元信息facet,慢 TTL(logo/name 极少变,没必要随价刷)。
export interface TokenInfo {
  ref: TokenRef;
  id?: string; // 内部代币行 id(store 读出的才有;source 直搜结果无)。logo 代理 key。
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

// 历史价观测点:某时刻的价(USD)。source 侧产原始观测(粒度随上游);tokens 服务按 UTC 日桶归一后
// 落缓存并对外返回(atMs = 该日桶起点 UTC 零点)。#148 / ADR 0019 的历史价骨架单元。
export interface TokenPricePoint {
  atMs: number;
  unitPrice: number;
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

// 展示分组(P2,ADR-0001):Token 所属的家族(可跨多个 Token)。无组 = undefined(单例组)。
export interface TokenGroup {
  id: string;
  displaySymbol: string;
  name: string;
  logo?: string;
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
  group?: TokenGroup; // 命中种子成员的 cgk 行才有;孤儿/未分组为 undefined
}

// provider 侧 seed(同步时采集):孤儿建行/已有行刷新 providerLogo 用。
export interface ProviderTokenSeed {
  symbol: string; // 已归一(大写)
  name?: string;
  providerLogo?: string;
}
