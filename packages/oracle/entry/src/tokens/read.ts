import type { TokenRecord } from "@folio/oracle-basic";
import type { TokenPriceStore, TokenStore } from "@folio/oracle-basic/ports";
import { Effect, Option } from "effect";

// 读行 —— **零网络**。拿内部 id 直接取整行,不回源、不判新鲜度。
//
// 「这是哪个币」在 `./mint` 就定死并冻进了快照,所以这里没有「解析」这一步,也不从 tokenRef
// 反推(ADR 0021)。「上游认没认出来」也不是一种状态:看 `TokenInfo.ref` 空不空就够,
// 行上没有孤儿标记、没有复查时刻、也没有带数据源名字的字段。
//
// 与 `./stale` 的分工:本片只**读**,读到 stale 的价照样原样给出去(`TokenRecord.price.stale`
// 带着这个事实)。要把它刷新是 `refreshStale` 的活,由调用方在合适的时机单独调 ——
// 富化一屏持仓不该顺手触发一串上游请求。
export interface TokenReading {
  // 富化:按内部 id 批量读整行(info + 价合并)。输入**不再需要** symbol 或 tokenRef。
  enrich(ids: readonly string[]): Effect.Effect<Map<string, TokenRecord>>;
  // 按主键读一行的上游图 URL(logo 代理端点用):源给的优先,没有就用连接器自带那张。
  logoUrlById(id: string): Effect.Effect<Option.Option<string>>;
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
