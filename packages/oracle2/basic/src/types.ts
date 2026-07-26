import type { TokenRef } from "@folio/oracle-ref";

// 参考层的领域类型(ADR 0021 / 0023)。沿用现有词表,不另造:
//   · `asset` = 持仓侧的【输入】(从 Balance 抽出的待解析身份)
//   · `token` = 参考层的一切(解析后的实体及其数据)
//   · **不出现任何数据源的名字** —— 「谁管它叫什么」由 tokenRef 的 `namer` 承载,
//     而那个 namer 是注入的 upstream 自报的(`TokenUpstream.id`),契约层不知道是哪家。
//
// 两条主线(ADR 0021):内部只认 `tokens.id`;`tokenRef` 只在两个边界出现
// (连接器报余额、oracle 问上游)。「上游认没认出这个币」不是一种状态 —— 看它有没有
// 那个 namer 的 ref 行,读出来就是 `TokenInfo.ref` 非空。

export type { TokenRef };

// —— 两个 facet(分开存 = 不同 TTL,ADR 0023)——

// 元信息 facet,慢 TTL(logo / name 极少变,没必要随价刷)。
// `ref` = 当前源对它的命名;`null` = 这个源还没认出它(不存额外状态)。
export interface TokenInfo {
  id: string;
  ref: TokenRef | null;
  symbol: string;
  name: string;
  logo?: string; // 源给的图(canonical)
  providerLogo?: string; // 连接器自带的图(备用槽;展示回退链第二档)
}

// 价 facet,快 TTL。`marketCapRank` 是市场数据,其权威 home 在此。
// 一律以 USD 计价;多法币在展示层换算,不进本层。
export interface TokenPrice {
  unitPrice: number;
  change24h?: number;
  marketCapRank?: number;
  asOf: number;
}

// 价 facet 读出形:**过期不删、带 stale 标**(SWR)—— 展示先给旧价,调用方后台刷新。
export interface TokenRecordPrice extends TokenPrice {
  stale: boolean;
}

// 代币整行 = 两个 facet 合起来,服务层读两个 store 后合并(store 各自只管自己那半)。
export interface TokenRecord extends TokenInfo {
  price?: TokenRecordPrice;
}

// —— 写入用的形状 ——

// provider 侧 seed(同步时采集):建行时它就是全部;归一到已有 Token 时**只填空槽、不覆盖**
// (那行可能已有源给的好数据)。
export interface ProviderTokenSeed {
  symbol: string; // 已归一(大写)
  name?: string;
  providerLogo?: string;
}

// 只填空槽的补丁:源后补的名字 / 图 / 排名。undefined 的字段一律不动。
export interface TokenInfoPatch {
  name?: string;
  logo?: string;
  providerLogo?: string;
}

// 写回一条价(按 token_id,不按 ref)。
export interface TokenPriceWrite extends TokenPrice {
  tokenId: string;
}

// —— 其余 ——

// 历史价观测点:atMs = 该 UTC 日桶起点。
export interface TokenPricePoint {
  atMs: number;
  unitPrice: number;
}

// 符号消歧的候选(瞬时,喂 `pickByConfidence`)。来自 warm,已带 `marketCapRank`;
// symbol 是查它的 key,值里不带。
export interface TokenCandidate {
  ref: TokenRef;
  marketCapRank?: number;
}

// 一条 ref 已经有主了。`linked` = 它指向的那个 Token **已经有当前源的 ref 行** ——
// 也就是已经认出来是哪个币了。mint 靠它区分「什么都不用做」与「该补链 / 该合并」,
// 免得每次同步都替所有已知的 ref 白查一遍全局映射(实现里是一次 join)。
export interface TokenRefHit {
  tokenId: string;
  linked: boolean;
}

// 全局映射表(`global_token_ref_index`,ADR 0022)一行:
// 「这条链上的 ref,在**那个命名者**那里叫这个」。两边都是 tokenRef,同一套文法。
export interface TokenRefIndexRow {
  ref: TokenRef; // 链上寻址:evm:<chainId>/<addr> / <slug>/<addr>
  namer: string; // 别名的命名者(= 注入 upstream 的 id)
  localName: string; // 那个命名者对它的叫法
}
