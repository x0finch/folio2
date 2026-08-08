import type { TokenPrice, TokenRecordPrice, TokenRef } from "@folio/oracle-basic";
import { PRICE_TTL_MS } from "@folio/oracle-basic";
import type { TokenPriceStore, TokenStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { Effect, Option } from "effect";
import { degradeTo } from "./degrade";
import { swr } from "./refresh";

// 现价。三个方法**按「有没有内部 id」分成两档**,这是本片的全部内容:
//
//   `priceOf`                    收 token_id  → 走 SWR,**会写回**价 store
//   `priceByRef` / `pricesByRefs` 收 tokenRef  → 现取,**不建行、不写缓存**
//
// 为什么第二档不能并进第一档:用户此刻只是在选币下拉里点了一下,按设计这一刻还不建行
// (他可能就把抽屉关了,留一堆没人要的代币行)。行是提交时才由 `./mint` 建的,而没有行就
// 没有 token_id、也就没有地方写价。
//
// **现价有两个家**,这是明知接受的:持仓币的价在价 store(估值用,要能按 token 点查),
// 选币列表的价在 warm blob 里(橱窗用,见 `./catalogue`),两边可能差几分钟。
export interface TokenPricing {
  // 取单价:新鲜 → 直接回;stale/miss → 回源 → 写回。长尾币按需取价走这条。
  priceOf(tokenId: string): Effect.Effect<Option.Option<TokenRecordPrice>>;
  // 选币表单预填单价:按 ref 现取,**不建行、不写缓存**。
  // 取不到(上游不认识 / 上游挂了)→ `none`,表单让用户自己填。
  priceByRef(ref: TokenRef): Effect.Effect<Option.Option<TokenPrice>>;
  // 选币下拉的 SWR 刷价:一批 ref 现取(`priceByRef` 的批量版)。同样**不建行、不写缓存** ——
  // 用户还在下拉里划。上游失败 → 空 Map,那几行显示无价。
  pricesByRefs(refs: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenPrice>>;
}

export const makePricing = (
  store: TokenStore,
  prices: TokenPriceStore,
  upstream: TokenUpstream,
): TokenPricing => ({
  // 单个币的价走 SWR:新鲜直接回、stale 回源写回、上游没有则保留旧值。
  priceOf: (tokenId) => {
    const read = Effect.map(prices.getByIds([tokenId]), (hits) =>
      Option.map(Option.fromNullable(hits.get(tokenId)), (hit) => ({
        value: hit,
        stale: hit.stale,
      })),
    );
    const fetch = Effect.gen(function* () {
      const info = yield* store.getById(tokenId);
      const ref = Option.flatMap(info, (i) => Option.fromNullable(i.ref));
      if (Option.isNone(ref)) return Option.none<TokenRecordPrice>(); // 认不出来的币取不了价
      const got = yield* upstream.fetchPrices([ref.value]);
      return Option.map(Option.fromNullable(got.get(ref.value)), (p) => ({
        ...p,
        stale: false,
      }));
    });
    return read.pipe(
      swr("tokens.priceOf", fetch, (value) => prices.put([{ tokenId, ...value }], PRICE_TTL_MS)),
    );
  },

  priceByRef: (ref) =>
    upstream.fetchPrices([ref]).pipe(
      Effect.map((found) => Option.fromNullable(found.get(ref))),
      degradeTo("tokens.priceByRef", Option.none<TokenPrice>()),
    ),

  pricesByRefs: (refs) =>
    refs.length === 0
      ? Effect.succeed(new Map<TokenRef, TokenPrice>())
      : // upstream 已按 IDS_PER_REQUEST 分块(#245),这里整批交给它。
        upstream
          .fetchPrices(refs)
          .pipe(degradeTo("tokens.pricesByRefs", new Map<TokenRef, TokenPrice>())),
});
