import { Oracle, type RefreshStaleReport } from "@folio/oracle";
import { Effect } from "effect";
import {
  type BalanceLike,
  displayTokenId,
  displayTokenIds,
  refreshableTokenIds,
  type TokenEnrichment,
  toEnrichment,
} from "./model";

// 代币展示富化 / 预热助手(非 server fn,server-only)。被 portfolio / sync-deps 复用。

// 展示富化(cache-only,零网络):**按 token_id 批量读整行**,按行挂富化字段(缺则原样降级)。
// 认定在写快照时已定死(ADR 0021 / #201),这里不再解析身份,也不再靠下标与返回数组配对 ——
// 后者是个长期的 locality 隐患(克隆或过滤一步就全错位)。
//
// 上游还没认出来的币也出 name/providerLogo(不再是裸 symbol + 首字母)。
export const enrichBalances = <T extends BalanceLike>(
  balances: T[],
): Effect.Effect<{ rows: (T & TokenEnrichment)[]; pricesStale: boolean }, never, Oracle> =>
  Effect.gen(function* () {
    // defi 行也做展示富化(H5 #120:抽屉协议行的 24h 聚合);估值现推路径不受影响
    // (那里仍只走 fungibleTokenId 的同质门)。
    const enriched = yield* Effect.flatMap(Oracle, (o) =>
      o.tokens.enrich(displayTokenIds(balances)),
    );
    // 刷价集合(#245:跳过 dust)。pricesStale 必须只在**这个集合内**判脏,否则被跳过的 dust 被标脏
    // 却永远刷不到 → pricesStale 清不掉、客户端每次进页空转刷新(即下面「三门同源」那条坑)。
    const refreshable = new Set(refreshableTokenIds(balances));
    let pricesStale = false;
    const rows = balances.map((b) => {
      const id = displayTokenId(b);
      if (!id) return b; // 没有身份的行不参与富化,也不算 stale(刷了也没用)
      const e = enriched.get(id);
      // stale = 过期**或压根没有价**。新层刚 mint 出的行正是「有身份、无价」,必须让客户端来刷一次,
      // 否则首屏永远没价而且没人去取(pricesStale 与 refreshStalePrices 必须同门,code review #2)。
      //
      // **但只算「刷得出来且值得刷」的行**:① `ref` 空 = 上游还没认出它(手记里自己敲名字的币恒是
      // 这样),刷价那侧本就跳过;② 不在 refreshable 里 = dust,刷价那侧也跳过(#245)。两种都标脏
      // 只会换来每次进页白发一次请求、而且永远清不掉。与上面「没有身份的行不算 stale」同一条理由。
      if (refreshable.has(id) && e?.ref && e.price?.stale !== false) pricesStale = true;
      return e ? { ...b, ...toEnrichment(e) } : b;
    });
    return { rows, pricesStale };
  });

// 持仓预热(写缓存,best-effort):把这批余额里价 / 元信息 stale/缺失的一次批量回源写回。
// cron(waitUntil)与手动 sync 后调用 —— cron 尤其需要,它没有前端来触发 pricesStale 那条刷价路径。
//
// **一个方法拿回两半的账**(`{ prices, infos, degraded }`):同一批 id 的两次 store 读因此只发一次,
// 而 `degraded` 让调用方分得清「没什么要刷」与「上游挂了」—— 后者该有人喊一声(#375)。
//
// **价与 logo/正名一起热**(与客户端 refreshStalePrices server fn 同构):新 mint 的行只有连接器报的
// 那点信息(BTC 这类连接器根本不报 logo),logo/正名的权威源是上游,唯一写入口是 `refreshStale` 的 info 那半。
// 从前这里只热价 → 首屏 pricesStale=false → 客户端那条「价脏才刷、顺带补 logo」的路径不触发 →
// 新账户 logo 空着干等 ~30min 价过期才补。两者各自失败不拖垮对方;info 的 TTL 长(30d),几乎不发请求。
//
// 走新参考层(按 token_id;#202 拔掉旧 `Tokens.warm(AssetRef[])`)。与 enrich 的 pricesStale gate /
// 客户端 refreshStalePrices 三门同源:都喂 `refreshableTokenIds` 出来的同一集合(#245:跳过 dust)。
export const warmHeldPrices = (
  balances: BalanceLike[],
): Effect.Effect<RefreshStaleReport, never, Oracle> =>
  Effect.flatMap(Oracle, (o) => o.tokens.refreshStale(refreshableTokenIds(balances)));
