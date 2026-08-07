import type { TokenCandidate, TokenMetaUpstream } from "@folio/oracle-basic";
import { DEFAULT_TOP_N, normalizeSymbol } from "@folio/oracle-basic";
import { CacheStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { Context, Effect, Layer } from "effect";
import { type WarmRow, warmBlob } from "./warm";

// mint 的 symbol 那一档要问的候选源(#216)。**包内的一个 Tag** —— 它从不出包:
// `oracleLayer` 在装配时就把它喂给 `TokenService` 吃掉了,调用方的 `R` 里看不到它。
//
// **为什么读写合成一个服务之后它还留着 Tag。** 它保的那件事没变:目录的**唯一一条出网路径**
// (冷缓存那一次)收在它自己的 layer 里,而 `./mint` 的 `MintDeps` 只拿得到这个服务的
// `bySymbol` —— mint 那半的作用域里没有任何 `*Upstream`(见 `./mint` 的红线)。
// 附带的一件同等重要:它是 mint 那组用例的**注入缝**。那组要数「有没有走到 symbol 这一档」
// (#210 的闸在合约上会提前返回,不数的话用例会因为压根没走到判官而空转绿掉),
// 所以必须能顶掉真实现 —— 用 Tag 顶,测试与生产就还是**同一条构造路**(fakes.ts 那条教训)。
// 换成 `makeTokenService(candidatesFn)` 之类的构造参数就会多出一条只有测试走的路。
//
// **做不到「类型上禁绝出网」** —— 冷缓存那一次躲不掉(候选集为空 = 所有按 symbol 认的币
// 集体认不出来)。能做到的是把唯一那条出网路径收在这一个服务里,谁 provide 谁看得见。
export interface CandidateSource {
  bySymbol(symbol: string): Effect.Effect<TokenCandidate[]>;
}

export const CandidateSource = Context.GenericTag<CandidateSource>("oracle/CandidateSource");

// —— warm blob 的第三个读者(另两个在 ../services/tokens)——
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
