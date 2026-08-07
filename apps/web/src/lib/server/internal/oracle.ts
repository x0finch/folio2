import { env } from "cloudflare:workers";
import type { UpstreamError } from "@folio/client-core";
import {
  createGlobalTokenRefIndexStore,
  createUserCacheStore,
  createUserTokenPriceStore,
  createUserTokenStore,
} from "@folio/db";
import {
  type OracleServices,
  oracleLayer,
  type RefIndexWarmer,
  refIndexWarmerLayer,
} from "@folio/oracle";
import {
  CacheStore,
  GlobalTokenRefIndexStore,
  TokenPriceStore,
  TokenStore,
} from "@folio/oracle-basic/ports";
import {
  coinGeckoFxUpstreamLayer,
  coinGeckoNamerLayer,
  coinGeckoPlatformUpstreamLayer,
  coinGeckoTokenUpstreamLayer,
  UPSTREAM_ID,
} from "@folio/oracle-upstream-coingecko";
import { Effect, Layer } from "effect";
import { logTapeLogger } from "./effect-log";
import {
  cacheStorePort,
  refIndexStorePort,
  tokenPriceStorePort,
  tokenStorePort,
} from "./oracle-ports";

// 参考层的装配点(ADR 0023,#199/#200)。**这是全仓唯一同时认识两边的文件** ——
// 一边是 D1 store,一边是 CoinGecko adapter;`@folio/oracle` 自己两边都不认识。
//
// #362 第 4 站之后这里给的是 **Layer**,不再是 `createOracleFor({ 七个工厂回调 })`。
// 少掉的东西:七个 `createXxx(userId)` 字段、`overrides` 的转手(adapter 的 layer 自己给
// `Namer`)、`onWarn` 回调(改 Effect 日志 + 下面那个转发器)、`now`(改 `Clock`)。
//
// **`runPromise` 只在这里出现**:server fn / route handler / cron 各自写一个 effect,交给
// `runOracle` 跑。以前是每个方法调用各自 await 一个 Promise,层与层之间没有共同的上下文;
// 现在一次请求一次装配,超时与中断能一路传到最底层那发 fetch。

// CoinGecko client 的公共配置(三个上游共用一份)。限速层的报告不在这里 —— 见 log.ts 的
// setLimitLogger:那件事是运行时的属性,设一次管所有闸,不该逐个上游透传。
const cgConfig = () => ({ apiKey: env.COINGECKO_API_KEY || undefined });

// 当前上游的命名者。db 层不预设任何厂商(表名列名零 vendor 字样,#199),所以凡是要按命名者
// 点查 `token_refs` 的读(如手记持仓的「用户选了哪个币」)都由 app 把它传进去。
// 取 adapter 导出的常量而不是从服务里拿 —— 后者会在模块加载期读 env(Workers 启动 CPU 限制)。
export const NAMER = UPSTREAM_ID;

// 三个上游端口 + 命名身份。**各自一个 layer**:汇率、平台、代币身份是三件事,当前恰好都落在
// CoinGecko 上,但那是这一行的选择,服务层不知道它们是同一家(ADR 0023)。
const upstreams = () =>
  Layer.mergeAll(
    coinGeckoTokenUpstreamLayer(cgConfig()),
    coinGeckoFxUpstreamLayer(cgConfig()),
    coinGeckoPlatformUpstreamLayer(cgConfig()),
    coinGeckoNamerLayer,
  );

// per-user 的四张 store。**`Layer.sync` 而不是 `Layer.succeed`** —— env 与 `getDb` 要到 layer
// 真被建的那一刻才碰(模块加载期一次都不碰:Workers 的启动 CPU 限制)。
//
// 惰性到「只建被用到的那一个」这件事**不再做了**:`packages/db/src/client.ts` 自己写着
// 「drizzle(env.DB) 很轻,每次创建即可」,四个 store 全建是常数级开销 —— 迁移前那套
// getter + `??=` 的手写惰性,省下的是不存在的代价,换来的是七个配置回调。
const portsFor = (userId: string) =>
  Layer.mergeAll(
    Layer.sync(TokenStore, () =>
      tokenStorePort(createUserTokenStore(env, { userId, namer: UPSTREAM_ID })),
    ),
    Layer.sync(TokenPriceStore, () =>
      tokenPriceStorePort(createUserTokenPriceStore(env, { userId, namer: UPSTREAM_ID })),
    ),
    Layer.sync(CacheStore, () => cacheStorePort(createUserCacheStore(env, { userId }))),
    Layer.sync(GlobalTokenRefIndexStore, () =>
      refIndexStorePort(createGlobalTokenRefIndexStore(env)),
    ),
  );

// 类型化的失败 → 普通 `Error`。**不让 `FiberFailure` 漏给调用方**:`runPromise` 默认抛的是它,
// 而 `Data.TaggedError` 的那四类没有 `message` 字段,于是上层日志里只剩一个空消息 + 一坨 Cause。
// 消息里只有 tag、pathname 和状态码 —— `where` 本来就刻意不带 query(原则 #5 红线)。
const toError = (error: UpstreamError): Error =>
  new Error(
    `${error.upstream} ${error._tag} on ${error.where}${
      error.status !== undefined ? ` (${error.status})` : ""
    }`,
    { cause: error },
  );

/**
 * 跑一个用了参考层的 effect。**一次请求一次装配** —— 一个 server fn 里连着问代币、汇率、平台,
 * 走的是同一份 context(以前是三次各自 new 一套 store)。
 *
 * 参考层现在装的是**用户私有**数据(他认识哪些币、他的币叫什么名),拿错用户就是数据泄露 ——
 * 所以 userId 是这个函数的必填参数,而服务的方法签名里一个 user 参数都没有:拿错在编译期
 * 就发生不了。cron 没有 auth 上下文,得逐用户自己调一次,那正是本签名想让它显而易见的事。
 */
export const runOracle = <A>(
  userId: string,
  effect: Effect.Effect<A, UpstreamError, OracleServices>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.provide(oracleLayer, Layer.merge(portsFor(userId), upstreams()))),
      Effect.provide(logTapeLogger),
      Effect.mapError(toError),
    ),
  );

/**
 * 全局维护任务(刷 `global_token_ref_index`)。**不带 userId** —— 这张表跟任何用户无关
 * (ADR 0022),所以 per-user 的那三张 store 压根不建。
 */
export const runOracleWarm = <A>(
  effect: Effect.Effect<A, UpstreamError, RefIndexWarmer>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.provide(
          refIndexWarmerLayer,
          Layer.merge(
            Layer.sync(GlobalTokenRefIndexStore, () =>
              refIndexStorePort(createGlobalTokenRefIndexStore(env)),
            ),
            coinGeckoTokenUpstreamLayer(cgConfig()),
          ),
        ),
      ),
      Effect.provide(logTapeLogger),
      Effect.mapError(toError),
    ),
  );
