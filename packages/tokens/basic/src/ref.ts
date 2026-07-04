import { TokenError } from "./errors";
import type { CgkCoinId, TokenRef } from "./types";

// `TokenRef` 的唯一序列化 —— map / store / 否定缓存 全用它做 key,别处不再手拼字符串。
export function refKey(ref: TokenRef): string {
  return `${ref.source}:${ref.identifier}`;
}

export function parseRefKey(key: string): TokenRef {
  const i = key.indexOf(":");
  if (i <= 0 || i === key.length - 1) {
    throw new TokenError("PARSE_ERROR", `invalid ref key: ${key}`);
  }
  const source = key.slice(0, i);
  const id = key.slice(i + 1);
  if (source !== "coingecko") {
    throw new TokenError("PARSE_ERROR", `unknown ref source: ${source}`);
  }
  return { source: "coingecko", identifier: id as CgkCoinId };
}
