import { type UpstreamError, UpstreamUnavailableError } from "@folio/client-core";
import { Clock, Effect } from "effect";
import { CHAINS_CACHE_TTL_MS, CHAINS_PATH } from "./constants";

// slug → 数字 chainId 的映射缓存。**近静态**(链的 chainId 不可变),24h 一刷。
//
// **为什么值得缓存**:每次取仓位都要它(拿不到就产不出规范的 `evm:<chainId>` 标识),
// 而它一天都不会变 —— 不缓存就是每个账户每轮同步都白拉一发,还占掉那把 key 的额度。
//
// **状态刻意在模块级,不在 `Scope` 里** —— 与 client-core 的时隙游标同一个理由:CF Workers 上
// 每个请求一次 `runPromise`、Layer memoisation 是 per-run 的,放 scope 就等于每请求重置,
// 缓存直接失效。isolate 能活几分钟到几小时,模块级才真的省下那一发。
//
// **按 baseUrl 分桶,不提供 reset** —— 测试用不同的 base 即天然隔离(同 slot 游标那套)。
// 少一个全局可变开关,也少一条「忘了 reset 就串味」的路。
const caches = new Map<string, ChainIdCache>();

export interface ChainIdCache {
  // 拿映射。`fetch` 是「真去拉一发」的 effect —— 由 client 提供(它才知道怎么带 key、走哪个闸)。
  readonly get: (
    fetch: Effect.Effect<Record<string, number>, UpstreamError>,
  ) => Effect.Effect<Record<string, number>, UpstreamError>;
}

export function cacheFor(baseUrl: string): ChainIdCache {
  const found = caches.get(baseUrl);
  if (found) return found;
  const created = makeCache();
  caches.set(baseUrl, created);
  return created;
}

function makeCache(): ChainIdCache {
  // 整段取值串行化:并发 miss 时只拉一发,其余等着复用 —— 老那版没锁,6 个账户冷启会同时拉 6 发,
  // 白占那把 key 的额度(而闸就在同一把 key 上,等于自己堵自己)。
  const lock = Effect.unsafeMakeSemaphore(1);
  let map: Record<string, number> | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;

  return {
    get: (fetch) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (map && now - fetchedAt < CHAINS_CACHE_TTL_MS) return map;

          const fresh = yield* Effect.either(fetch);
          if (fresh._tag === "Right" && Object.keys(fresh.right).length > 0) {
            map = fresh.right;
            fetchedAt = now;
            return map;
          }

          // **刷新失败但有旧映射 → 用旧的。** chainId 不可变,旧的仍然产出正确的规范标识 ——
          // 比让整轮取数失败强。(空响应与请求失败在这里同等对待:都是「这次没拿到」。)
          if (map) return map;

          // 一个映射都没有 → 硬失败。**绝不退化成 slug 兜底形**:那会与规范形分裂身份、
          // 污染代币索引。失败即不产,整轮重试。
          return yield* fresh._tag === "Left"
            ? Effect.fail(fresh.left)
            : Effect.fail(
                new UpstreamUnavailableError({
                  upstream: "zerion",
                  where: CHAINS_PATH,
                  cause: "chains response contained no usable chainIds",
                }),
              );
        }),
      ),
  };
}

// 链清单 → slug→数字 chainId(external_id hex → 十进制)。
//
// **这个转换留在 client**,虽然它长得像 parse:它把上游的两种表示(hex 串)统一成一个数,
// 是「读懂上游怎么说话」,不涉及任何 folio 概念。适配层拿到的就该是能直接用的 chainId。
export function parseChainIds(res: {
  data?: { id?: string; attributes?: { external_id?: string } }[];
}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of res.data ?? []) {
    const hex = c.attributes?.external_id;
    if (!c.id || !hex) continue;
    const n = Number.parseInt(hex, 16);
    if (Number.isFinite(n)) out[c.id] = n;
  }
  return out;
}
