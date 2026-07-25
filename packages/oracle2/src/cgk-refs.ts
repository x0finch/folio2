import type { CgkRefStore, TokenSource } from "./stores";
import type { TokenRef } from "./types";

export interface CgkRefsDeps {
  store: CgkRefStore;
  source: TokenSource;
}

// 全局 contract → coin 映射(ADR 0022):写路径靠它把「某条链上的某个地址」翻成「哪个币」,
// 全程本地、不碰网络。表由 cron 一天一次整份刷新。
export interface CgkRefs {
  // 正查一批。miss 的键不出现在结果里。
  lookup(refs: readonly TokenRef[]): Promise<Map<TokenRef, string>>;
}

export function createCgkRefs({ store }: CgkRefsDeps): CgkRefs {
  return {
    lookup: (refs) => (refs.length === 0 ? Promise.resolve(new Map()) : store.lookup(refs)),
  };
}
