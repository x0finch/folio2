import type { CacheStore, TokenMetaUpstream } from "@folio/oracle-basic";
import { DEFAULT_TOP_N } from "@folio/oracle-basic";
import { candidatesBySymbol, warmCatalogue } from "./cache";
import type { CandidateSource } from "./mint";

// mint 的 symbol 那一档要问的候选源(#216)。**独立一个工厂,不再挂在 `Tokens` 上。**
//
// 为什么搬出来:它以前是 `tokens.candidates`,而 `Tokens` 那一大堆能力里有好几个是要出网的
// (刷价、取历史、搜索)。装配时一句 `candidates: this.tokens.candidates` 就把整个读路径的
// 网络面接进了写路径 —— mint 那句「全程不碰网络」于是成了假话,而代码里看不出来。
//
// 现在这个工厂只拿两样:一张本地缓存,和一个**叫 `coldStart` 的**回源函数。
// **做不到「类型上禁绝出网」** —— 冷缓存那一次躲不掉(候选集为空 = 所有按 symbol 认的币
// 集体认不出来)。能做到的是把唯一那条出网路径收进一个名字里,谁接线谁看得见,而不是藏在
// 一个叫 `tokens` 的大对象背后。
export interface CandidateSourceDeps {
  cache: CacheStore;
  // **唯一的出网口**,且只在缓存完全为空时被调用(见 warmCatalogue)。
  coldStart: TokenMetaUpstream;
  topN?: number;
  now?: () => number;
}

export function createCandidateSource({
  cache,
  coldStart,
  topN = DEFAULT_TOP_N,
  now = Date.now,
}: CandidateSourceDeps): CandidateSource {
  return {
    async bySymbol(symbol) {
      return candidatesBySymbol(await warmCatalogue(cache, coldStart, topN, now()), symbol);
    },
  };
}
