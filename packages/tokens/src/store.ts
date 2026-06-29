import type { Fiat, TokenIndex, TokenInfo, TokenPrice, TokenRef } from "./types";

// 全局参考数据缓存。**无 `userId`** —— 价/索引/元信息都是全局事实(原则 #6 受控例外,
// 同 cron 的 `listUserIdsWithAccounts`)。所有 key 走 `refKey`;实现 = P7.3(D1)。
export interface TokenStore {
  getIndex(): Promise<TokenIndex | null>;
  putIndex(index: TokenIndex, ttlMs: number): Promise<void>;

  // 返回按 refKey 索引;缺失即未命中。
  getInfo(refs: TokenRef[]): Promise<Map<string, TokenInfo>>;
  putInfo(infos: TokenInfo[], ttlMs: number): Promise<void>;

  // 价按 `vs` 分桶;key=refKey。
  getPrices(refs: TokenRef[], vs: Fiat): Promise<Map<string, TokenPrice>>;
  putPrices(prices: TokenPrice[], ttlMs: number): Promise<void>;

  // 解析不中(404)的否定占位,免每次重撞;key=refKey 或 symbol/contract 查询键。
  isAbsent(key: string): Promise<boolean>;
  putAbsent(key: string, ttlMs: number): Promise<void>;
}
