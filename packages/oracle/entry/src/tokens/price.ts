import type { DbRequest, TokenPriceStore, TokenStore } from "@folio/db";
import type { TokenPrice, TokenRecord, TokenRecordPrice, TokenRef } from "@folio/oracle-basic";
import type { TokenUpstream } from "@folio/oracle-basic/ports";
import { Effect, Option } from "effect";
import { degradeTo } from "./swr";

// 读 —— **现价 + 整行富化**。两半都拿内部 id(或选币时的 ref)直接取数,不从 tokenRef 反推
// (ADR 0021:身份在 `./mint` 定死)。
//
// —— 整行(`enrich` / `logoUrlById`)—— **零网络**,不回源、不判新鲜度。
// 读到 stale 的价照样原样给出去(`TokenRecord.price.stale` 带着这个事实)。要刷新是
// `./stale` 的活,由调用方在合适的时机单独调 —— 富化一屏持仓不该顺手触发一串上游请求。
//
// —— 现价 —— 三个方法**按「有没有内部 id」分成两档**:
//   `pricesOf`                   收 token_id  → **只读价 store,零网络**(一批一次读)
//   `priceByRef` / `pricesByRefs` 收 tokenRef  → 现取,**不建行、不写缓存**
//
// 第一档以前是 `priceOf`:单个 id 走 SWR、stale 就当场回源写回。同步的重估对每笔持仓调它一次,
// 于是一次同步 = 每个币一发 CoinGecko(并发无上限),在免费计划的「一次调用 50 发」里注定超
// (FOL-87)。现在回源只有一处 —— `./stale` 的 `refreshStale`(按 100 个一批),由队列的 `prices`
// 活每小时跑;读价的人一律只读表,表里多旧就用多旧(`stale` 标志如实带着)。
//
// 为什么第二档不能并进第一档:用户此刻只是在选币下拉里点了一下,按设计这一刻还不建行
// (他可能就把抽屉关了,留一堆没人要的代币行)。行是提交时才由 `./mint` 建的,而没有行就
// 没有 token_id、也就没有地方写价。
//
// **现价有两个家**,这是明知接受的:持仓币的价在价 store(估值用,要能按 token 点查),
// 选币列表的价在 warm blob 里(橱窗用,见 `./catalogue`),两边可能差几分钟。

export interface TokenReading {
  // 富化:按内部 id 批量读整行(info + 价合并)。输入**不再需要** symbol 或 tokenRef。
  enrich(ids: readonly string[]): Effect.Effect<Map<string, TokenRecord>, never, DbRequest>;
  // 按主键读一行的上游图 URL(logo 代理端点用):源给的优先,没有就用连接器自带那张。
  logoUrlById(id: string): Effect.Effect<Option.Option<string>, never, DbRequest>;
}

export interface TokenPricing {
  // 一批 token_id 的现价,**只读价 store**:不判新鲜度、不回源、不写回(stale 的照样给,标志带着)。
  // 表里没有的 id 不在结果里。同步的重估走这条 —— 它在写路径上,不该顺手出网(FOL-87)。
  pricesOf(
    tokenIds: readonly string[],
  ): Effect.Effect<Map<string, TokenRecordPrice>, never, DbRequest>;
  // 选币表单预填单价:按 ref 现取,**不建行、不写缓存**。
  // 取不到(上游不认识 / 上游挂了)→ `none`,表单让用户自己填。
  priceByRef(ref: TokenRef): Effect.Effect<Option.Option<TokenPrice>>;
  // 选币下拉的 SWR 刷价:一批 ref 现取(`priceByRef` 的批量版)。同样**不建行、不写缓存** ——
  // 用户还在下拉里划。上游失败 → 空 Map,那几行显示无价。
  pricesByRefs(refs: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenPrice>>;
}

export const makeReading = (store: TokenStore, prices: TokenPriceStore): TokenReading => ({
  enrich: (ids) =>
    Effect.gen(function* () {
      if (ids.length === 0) return new Map<string, TokenRecord>();
      // 两个 store 各读自己那半,服务层合成整行 —— 这正是切开端口的用处。
      // 并发度写出来(以前是 `Promise.all` 的隐式「全都一起上」)。
      const [infos, priced] = yield* Effect.all([store.getByIds(ids), prices.getByIds(ids)], {
        concurrency: 2,
      });
      const out = new Map<string, TokenRecord>();
      for (const [id, info] of infos) out.set(id, { ...info, price: priced.get(id) });
      return out;
    }),

  logoUrlById: (id) =>
    Effect.map(store.getById(id), (info) =>
      Option.flatMap(info, (i) => Option.fromNullable(i.logo ?? i.providerLogo)),
    ),
});

export const makePricing = (prices: TokenPriceStore, upstream: TokenUpstream): TokenPricing => ({
  // 空输入不查库由 store 自己兜(`getByIds` 开头那句)。
  pricesOf: (tokenIds) => prices.getByIds(tokenIds),

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
