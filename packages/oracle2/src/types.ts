import type { TokenRef } from "@folio/oracle-ref";

// 参考层的领域类型(ADR 0021)。一条主线贯穿全包:
//   · **内部只认 `Token.id`** —— 它是这个 user 认识的某个币在系统里唯一的身份。
//   · `tokenRef` 只在**两个边界**出现:连接器报余额时说「我管它叫什么」,oracle 问 CoinGecko 时
//     说「你管它叫什么」。中间的一切(快照、聚合、展示、历史)一律 `token_id`。
//   · 「CoinGecko 认没认识这个币」**不是一种状态** —— 看它有没有 `coingecko` 那条 ref 就行。
//     旧的「孤儿行 / CGK 行 / 复查三态」整个不存在。

export type { TokenRef };

// 代币表一行的读出形。
export interface Token {
  id: string;
  symbol: string;
  name: string;
  logo?: string; // CoinGecko 的图
  providerLogo?: string; // provider 自带的图(展示回退链的第二档)
  marketCapRank?: number;
  price?: TokenPrice;
  // CoinGecko 管它叫什么。有 = 已认出;无 = 还没有(不存额外状态,见上)。
  cgkCoinId?: string;
}

// 价 facet。过期不删、读出带 stale —— 展示先给旧价,调用方后台刷新(SWR)。
export interface TokenPrice {
  unitPrice: number;
  change24h?: number;
  asOf: number;
  stale: boolean;
}

// provider 报的元信息。建行时它就是全部;归一到已有 Token 时**只填空槽、不覆盖**
// (那行可能已有 CoinGecko 的好数据)。
export interface TokenSeed {
  symbol: string;
  name?: string;
  logo?: string;
}

// 只填空槽的补丁:CoinGecko 后补的名字 / 图 / 排名。undefined 的字段一律不动。
export interface TokenInfoPatch {
  name?: string;
  logo?: string;
  providerLogo?: string;
  marketCapRank?: number;
}

// 写回一条价(按 token_id,不按 ref)。
export interface TokenPriceWrite {
  tokenId: string;
  unitPrice: number;
  change24h?: number;
  marketCapRank?: number;
  asOf: number;
}

// 历史日价观测点:atMs = 该 UTC 日桶起点。
export interface PricePoint {
  atMs: number;
  unitPrice: number;
}

// `cgk_refs` 一行:某条链上的某个地址 → CoinGecko 的 coin id(全局知识,无 userId,ADR 0022)。
// 原生币不产行(它们在 CoinGecko 的 platforms 字典里是空的,靠 symbol 认)。
export interface CgkRefRow {
  ref: TokenRef;
  coinId: string;
}
