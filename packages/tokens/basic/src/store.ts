import type { TokenCandidate, TokenInfo, TokenPrice, TokenRef } from "./types";

// 全局参考数据缓存。**无 `userId`** —— 价/解析/元信息都是全局事实(原则 #6 受控例外,
// 同 cron 的 `listUserIdsWithAccounts`)。点查,无整份 index;通用层只用 `chain`(各 source 的内部命名不外泄)。
// 实现 = P7.3.1(KV)。
export interface TokenStore {
  // warm(top-N markets):symbol→候选(带 rank);`putWarm` 同时落 info/price 供富化读取。
  // ttlMs 管 warm 承载(rank)与 price(短、要新鲜);infoTtlMs 管 name/logo(长、近静态)。
  getCandidates(symbol: string): Promise<TokenCandidate[]>;
  putWarm(
    rows: { info: TokenInfo; price: TokenPrice }[],
    ttlMs: number,
    infoTtlMs: number,
  ): Promise<void>;
  warmAsOf(): Promise<number | null>;
  // 默认选币列表(P7.4.5):warm 候选按 `marketCapRank` 升序取前 `limit`,连 name/logo 一并返回。
  // 实现须 join 元信息(rank 在 warm、name/logo 在 info),未预热则空(调用方回退预热)。
  listTopTokens(limit: number): Promise<TokenInfo[]>;

  // 合约懒解析缓存,按 (chain, contract) 键,三态:`TokenRef` 命中 / `null` 已知缺失 / `undefined` 未知(去取)。
  getContractRef(chain: string, contract: string): Promise<TokenRef | null | undefined>;
  putContractRef(
    chain: string,
    contract: string,
    ref: TokenRef | null,
    ttlMs: number,
  ): Promise<void>;

  // 富化读取(P7.4):按 refKey 索引,缺失即未命中。
  getInfo(refs: TokenRef[]): Promise<Map<string, TokenInfo>>;
  putInfo(infos: TokenInfo[], ttlMs: number): Promise<void>;
  getPrices(refs: TokenRef[]): Promise<Map<string, TokenPrice>>;
  putPrices(prices: TokenPrice[], ttlMs: number): Promise<void>;
}
