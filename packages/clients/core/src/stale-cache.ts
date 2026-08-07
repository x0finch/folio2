import { Clock, Effect } from "effect";
import type { UpstreamError } from "./upstream-error";

// 「近静态的东西,拉一次用一天」的缓存 —— 两家上游都要:zerion 与 rabby 的 slug→chainId 映射
// (链的 chainId 不可变)。各写一份就是两份同构的 TTL + 陈旧回落 + 并发锁。
//
// **三条行为是这个缓存存在的理由,少一条就不该用它**:
//
//   · **TTL** —— 不缓存的话每个账户每轮同步都白拉一发,还占掉那把 key 的额度
//   · **刷新失败回落到旧值** —— 值不可变,旧的仍然正确,比让整轮取数失败强
//   · **并发只拉一发** —— 老那两版都没锁,6 个账户冷启会同时拉 6 发,白占额度
//
// **状态刻意在模块级,不在 `Scope` 里** —— 与时隙游标同一个理由:CF Workers 上每个请求一次
// `runPromise`、Layer memoisation 是 per-run 的,放 scope 就等于每请求重置,缓存直接失效。
// isolate 能活几分钟到几小时,模块级才真的省下那一发。
//
// **分桶不提供 reset** —— 桶的身份是 `upstream + name + scope` 三段(见下),测试给自己一个
// scope 即天然隔离。少一个全局可变开关,也少一条「忘了 reset 就串味」的路。
//
// 桶存成 `unknown`,**只在出口断言一次** —— 存的时候再断言一次(`as unknown as` 来回转)是白费:
// 桶的类型参数由 key 决定,而 key 是运行时的字符串,类型系统本来就管不着这件事,转两次不会
// 让它更安全,只会让「这里有个断言」出现两遍。
const buckets = new Map<string, unknown>();

export interface StaleTolerantCache<A> {
  // 拿值。`fetch` 是「真去拉一发」的 effect —— 由 client 提供(它才知道怎么带凭据、走哪个闸)。
  //
  // `R` 透传:拉那一发需要什么能力(现在是出网),缓存不消费也不规定,原样写回出口 ——
  // 缓存不该对「怎么拉」有意见。
  readonly get: <R>(
    fetch: Effect.Effect<A, UpstreamError, R>,
  ) => Effect.Effect<A, UpstreamError, R>;
}

export interface StaleTolerantCacheOptions<A> {
  // —— 桶的身份,**三段分开给,不收一个拼好的串** ——
  //
  // 拼串那种写法(`key: \`zerion:chains:${baseUrl}\`)靠每个调用方记得带对前缀,而写重了的后果是
  // **一家上游的缓存被另一家读走**,跨包才撞、类型系统管不着、单包测试也测不出来。分成三段之后
  // 撞桶要三段全同,而 `upstream` 是每个包的常量。
  readonly upstream: string; // "zerion" / "rabby"
  readonly name: string; // 缓存的是什么,如 "chains"
  readonly scope: string; // 同一个上游内还要再分的维度,通常是 baseUrl(测试靠它天然隔离)
  readonly ttlMs: number;
  // 「这次拉回来的等于没拉到」。默认永远为 false(拿到就算数)。链清单用它排掉 200 + 空列表:
  // 那种响应存进去会让整整一天的取数都产不出规范标识。
  readonly isEmpty?: (value: A) => boolean;
  // 一个值都没有(首次就拉失败,或首次拉回来是空的)时报什么错。
  readonly onEmpty: () => UpstreamError;
}

export function staleTolerantCache<A>(
  options: StaleTolerantCacheOptions<A>,
): StaleTolerantCache<A> {
  const key = `${options.upstream}:${options.name}:${options.scope}`;
  const found = buckets.get(key);
  if (found) return found as StaleTolerantCache<A>;
  const created = makeCache(options);
  buckets.set(key, created);
  return created;
}

function makeCache<A>(options: StaleTolerantCacheOptions<A>): StaleTolerantCache<A> {
  // 整段取值串行化:并发 miss 时只拉一发,其余等着复用。
  const lock = Effect.unsafeMakeSemaphore(1);
  const isEmpty = options.isEmpty ?? (() => false);
  let value: A | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;

  return {
    get: (fetch) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (value !== undefined && now - fetchedAt < options.ttlMs) return value;

          const fresh = yield* Effect.either(fetch);
          if (fresh._tag === "Right" && !isEmpty(fresh.right)) {
            value = fresh.right;
            fetchedAt = now;
            return value;
          }

          // 刷新失败(或拉回来是空的)但有旧值 → 用旧的。
          if (value !== undefined) return value;

          // 一个值都没有 → 硬失败。拉失败就报那个失败(保住 429 / 401 的语义),
          // 拉回来是空的就报调用方给的那个。
          return yield* Effect.fail(fresh._tag === "Left" ? fresh.left : options.onEmpty());
        }),
      ),
  };
}
