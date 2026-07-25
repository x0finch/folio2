import type { CacheStore, TokenSource, TokenStore } from "./stores";
import type { Token } from "./types";

export interface TokensDeps {
  store: TokenStore;
  cache: CacheStore;
  source: TokenSource;
}

// 读路径。**没有「解析」这一步** —— 拿 token_id 直接取名字、图、现价、涨跌、市值排名,
// 不再从 tokenRef 反推身份(那件事在写路径就定死了,见 mint.ts)。
export interface Tokens {
  // 按内部 id 批量读整行。miss 的 id 不出现在结果里。
  byIds(ids: readonly string[]): Promise<Map<string, Token>>;
}

export function createTokens({ store }: TokensDeps): Tokens {
  return {
    byIds: (ids) => (ids.length === 0 ? Promise.resolve(new Map()) : store.getByIds(ids)),
  };
}
