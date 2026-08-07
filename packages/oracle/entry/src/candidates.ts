import type { TokenCandidate, TokenMetaUpstream } from "@folio/oracle-basic";
import { DEFAULT_TOP_N, normalizeSymbol } from "@folio/oracle-basic";
import { CacheStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { Context, Effect, Layer } from "effect";
import { type WarmRow, warmBlob } from "./warm";

// mint 的 symbol 那一档要问的候选源(#216)。**独立一个服务,不挂在 `TokenReader` 上。**
//
// 为什么搬出来:它以前是 `tokens.candidates`,而 `TokenReader` 那一大堆能力里有好几个是要出网的
// (刷价、取历史、搜索)。装配时一句 `candidates: this.tokens.candidates` 就把整个读路径的
// 网络面接进了写路径 —— mint 那句「全程不碰网络」于是成了假话,而代码里看不出来。
//
// 现在它是一个 Tag:mint 的 `R` 里只有 `CandidateSource`,而这个服务的 layer 才要
// `CacheStore | TokenUpstream`。**「有没有出网的可能」于是是编译期看得见的事** ——
// 读 mint 的签名就知道,不必去追一个叫 `tokens` 的大对象里有什么。
//
// **做不到「类型上禁绝出网」** —— 冷缓存那一次躲不掉(候选集为空 = 所有按 symbol 认的币
// 集体认不出来)。能做到的是把唯一那条出网路径收在这一个服务里,谁 provide 谁看得见。
export interface CandidateSource {
  bySymbol(symbol: string): Effect.Effect<TokenCandidate[]>;
}

export const CandidateSource = Context.GenericTag<CandidateSource>("oracle/CandidateSource");

// —— warm blob 的第三个读者(另两个在 ./tokens)——
// 三条判据为什么不同、为什么都落在 blob 自己的 `asOf` 上,见 ./warm 的开头。

/**
 * 目录读者。**有就用,多旧都用;只有完全没有时才回源一次。**
 *
 * 它问的是「哪个币叫 POL」—— 这个答案几乎不变,不值得让写路径为它出网。而完全没有时躲不掉:
 * 候选集为空意味着所有按 symbol 认的币(交易所持仓、没选币的手记)全都认不出来,新用户
 * 第一次同步会集体没有价。因为 `user_cache` 过期不删,这一取一辈子只会发生一次。
 *
 * 代价:某个币新进前 1000,要等下一次橱窗刷新(或预热)之后才认得出来。可接受 —— 它本来
 * 也得先爬进前 1000。
 */
export const warmCatalogue = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[]> => warmBlob(cache, upstream, topN, () => false);

// 按 symbol 筛候选。**与排行榜同一份 rows** —— 候选不额外存一份。
export function candidatesBySymbol(rows: readonly WarmRow[], symbol: string): TokenCandidate[] {
  const want = normalizeSymbol(symbol);
  const out: TokenCandidate[] = [];
  for (const r of rows) {
    if (normalizeSymbol(r.info.symbol) !== want) continue;
    out.push({ ref: r.info.ref, marketCapRank: r.price.marketCapRank });
  }
  return out;
}

export const candidateSourceLayer: Layer.Layer<CandidateSource, never, CacheStore | TokenUpstream> =
  Layer.effect(
    CandidateSource,
    Effect.gen(function* () {
      const cache = yield* CacheStore;
      // **唯一的出网口**,且只在缓存完全为空时被调用(见 `warmCatalogue`)。
      const coldStart = yield* TokenUpstream;
      return {
        bySymbol: (symbol) =>
          Effect.map(warmCatalogue(cache, coldStart, DEFAULT_TOP_N), (rows) =>
            candidatesBySymbol(rows, symbol),
          ),
      };
    }),
  );
