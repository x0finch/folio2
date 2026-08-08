import { INFO_TTL_MS, normalizeSymbol, PRICE_TTL_MS } from "@folio/oracle-basic";
import type { TokenPriceStore, TokenStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { Effect } from "effect";
import { logDegraded } from "./degrade";

// 后台刷新 —— **本片是唯一一处覆盖写既有行的地方**(价与元信息各一条上游端点)。
//
// 名字里的 stale 就是判据:只刷「该刷了」的那批,不是全刷。谁算该刷由两个 store 说
// (价的 `stale`、info 的 `infoStale`),本片只读那两个标志、不自己算 TTL。
export interface TokenStaleRefresh {
  // 后台预热:这批 token 里价 / 元信息 stale 或缺失的,各一次批量回源写回。
  //
  // **一个方法而不是两个**:所有调用点(同步后的 `warmHeldPrices`、客户端触发的刷价 server fn)
  // 都是成对调用,而两个方法各自开头都要 `store.getByIds(ids)` —— 同一批 id 的 D1 读必然发两次,
  // 又因为是并发调的,连「第二次碰巧命中」都不存在。合起来之后 store 读一次、价 store 读一次,
  // 价与 info 两条 fetch+write 分支再并发。
  //
  // 价与 info 仍是**两个上游端点、两套 TTL**(名与图近乎静态 30d,价 30min),只是共用那两次读。
  //
  // `degraded` = 这一轮有上游挂了(而不是「没什么要刷」)。`E` 仍是 `never` —— 调用方不被逼 catch,
  // 变化只是「挂了」从只进日志变成也进返回值,于是「连续几天暖不上价」有了抓手(#375)。
  refreshStale(ids: readonly string[]): Effect.Effect<RefreshStaleReport>;
}

export interface RefreshStaleReport {
  // 写回了几条价 / 几条元信息。
  prices: number;
  infos: number;
  // 这一轮有没有因为上游挂了而少刷 —— 与「本来就没什么要刷」是两件事。
  degraded: boolean;
}

export const makeStaleRefresh = (
  store: TokenStore,
  prices: TokenPriceStore,
  upstream: TokenUpstream,
): TokenStaleRefresh => {
  // 一批 (ref → tokenId) 的价:回源 → 写回。返回写了几条 + 这一轮有没有降级。
  const refreshPrices = (
    byRef: Map<string, string>,
  ): Effect.Effect<{ written: number; degraded: boolean }> =>
    Effect.gen(function* () {
      if (byRef.size === 0) return { written: 0, degraded: false };
      const fetched = yield* Effect.either(upstream.fetchPrices([...byRef.keys()]));
      if (fetched._tag === "Left") {
        yield* logDegraded("tokens.refreshStale.prices", fetched.left);
        return { written: 0, degraded: true };
      }
      const writes = [...fetched.right.entries()]
        .map(([ref, price]) => {
          const tokenId = byRef.get(ref);
          // 上游回了我们没问的(或已被合并掉的)ref → 丢掉,别写野行。
          return tokenId ? { tokenId, ...price } : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) yield* prices.put(writes, PRICE_TTL_MS);
      return { written: writes.length, degraded: false };
    });

  // 一批 (ref → tokenId) 的元信息:回源 → **覆盖**写回(上游是这三个字段的权威 home)。
  //
  // 为什么必须覆盖而不是填空槽:行是拿连接器报的元信息建的,而链上合约的 symbol 是部署者写在
  // 合约里的字符串 —— MATIC 改名 POL 之后链上那份还写着 MATIC。合约那条 ref 是**按地址**
  // 认出来的、认定可信,错的只是显示名。同一个币于是在链上侧显示 MATIC、在交易所侧显示 POL,
  // 而它们其实是同一行 —— 用户看到的名字取决于哪个账户先同步,这不该是随机的。
  const refreshInfos = (
    byRef: Map<string, string>,
  ): Effect.Effect<{ written: number; degraded: boolean }> =>
    Effect.gen(function* () {
      if (byRef.size === 0) return { written: 0, degraded: false };
      const fetched = yield* Effect.either(upstream.fetchTokens([...byRef.keys()]));
      if (fetched._tag === "Left") {
        yield* logDegraded("tokens.refreshStale.infos", fetched.left);
        return { written: 0, degraded: true };
      }
      const writes = fetched.right
        .map((t) => {
          const tokenId = byRef.get(t.ref);
          // 上游没收录的 ref 不在结果里;回来了却对不上我们要的键 → 丢掉,别乱写。
          //
          // **symbol 要归一。** 大小写是**我们**的展示口径,不是上游的 —— CoinGecko 给的是小写
          // (`usdc`),而建行那一侧是大写。不归一就出现「同一行刷一次变小写」:显示从 `USDC`
          // 跳成 `usdc`,而且 symbol 还是 symbol 消歧的比较键(见 `./candidates`)。
          // 覆盖上游的**名字**是对的(MATIC→POL),但那是内容,大小写不是。
          return tokenId
            ? { tokenId, symbol: normalizeSymbol(t.symbol), name: t.name, logo: t.logo }
            : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) yield* store.putInfo(writes, INFO_TTL_MS);
      return { written: writes.length, degraded: false };
    });

  return {
    refreshStale: (ids) =>
      Effect.gen(function* () {
        if (ids.length === 0) return { prices: 0, infos: 0, degraded: false };
        // 两次读,不是四次 —— 价那半与 info 那半共用它们。
        const [infos, priced] = yield* Effect.all([store.getByIds(ids), prices.getByIds(ids)], {
          concurrency: 2,
        });

        // 只刷「认得出来且价 stale/缺失」的。
        const priceTargets = new Map<string, string>();
        for (const [id, info] of infos) {
          const p = priced.get(id);
          if (p && !p.stale) continue;
          if (info.ref) priceTargets.set(info.ref, id);
        }

        // 元信息只刷「认得出来(ref 非空)且 info stale」的:认不出来的行没有上游名字可取,
        // 它显示连接器报的那份就是对的。
        const infoTargets = new Map<string, string>();
        for (const [id, info] of infos) {
          if (!info.infoStale || !info.ref) continue;
          infoTargets.set(info.ref, id);
        }

        // 两条分支并发。**各自的上游失败不拖垮对方** —— `Effect.either` 而不是 `degradeTo`:
        // 除了记一行,还要把「挂了」带回给调用方(见 `RefreshStaleReport.degraded`)。
        const [priceOutcome, infoOutcome] = yield* Effect.all(
          [refreshPrices(priceTargets), refreshInfos(infoTargets)],
          { concurrency: 2 },
        );
        return {
          prices: priceOutcome.written,
          infos: infoOutcome.written,
          degraded: priceOutcome.degraded || infoOutcome.degraded,
        };
      }),
  };
};
