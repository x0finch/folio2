import { env } from "cloudflare:workers";
import type { UpstreamError } from "@folio/client-core";
import {
  databaseLayer,
  globalTokenRefIndexStoreLayer,
  userCacheStoreLayer,
  userTokenPriceStoreLayer,
  userTokenStoreLayer,
} from "@folio/db";
import { type OraclePorts, type OracleServices, oracleLayer } from "@folio/oracle";
import type { GlobalTokenRefIndexStore, TokenUpstream } from "@folio/oracle-basic/ports";
import {
  coinGeckoFxUpstreamLayer,
  coinGeckoNamerLayer,
  coinGeckoPlatformUpstreamLayer,
  coinGeckoTokenUpstreamLayer,
  UPSTREAM_ID,
} from "@folio/oracle-upstream-coingecko";
import { Effect, Layer } from "effect";
import { logTapeLogger } from "./effect-log";

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

// per-user 的三张 store + 那张全局表,都由 `@folio/db` 直接给 Layer(#362 第 5 站)——
// 以前这里还有一层 30 行的 `Effect.promise` 适配(`oracle-ports.ts`),因为 db 那边是 Promise 形状;
// 现在四个 store 自己就是 Effect,那个文件删了,`env` 也只在 `databaseLayer(env)` 一处被读。
//
// 惰性到「只建被用到的那一个」这件事**不做**:`packages/db/src/connect.ts` 自己写着
// 「drizzle(env.DB) 很轻,每次创建即可」,而现在四个 store 共用同一个 `Database`——
// 建它们只是几个闭包。迁移前那套 getter + `??=` 的手写惰性,省下的是不存在的代价。
const portsFor = (userId: string) =>
  Layer.provide(
    Layer.mergeAll(
      userTokenStoreLayer({ userId, namer: UPSTREAM_ID }),
      userTokenPriceStoreLayer({ userId, namer: UPSTREAM_ID }),
      userCacheStoreLayer({ userId }),
      globalTokenRefIndexStoreLayer,
    ),
    databaseLayer(env),
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
  effect: Effect.Effect<A, UpstreamError, OracleServices | OraclePorts>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      // `provideMerge` 而不是 `provide`:端口也透出去。app 自己有一小片直接用 `CacheStore`
      // (DeFi 协议图 —— 没有上游、不属于参考层,见 `defi-logo-store.ts`),而这些端口本来就是
      // 这个文件建的,没必要为了用它们再包一个服务。
      Effect.provide(Layer.provideMerge(oracleLayer, Layer.merge(portsFor(userId), upstreams()))),
      Effect.provide(logTapeLogger),
      Effect.mapError(toError),
    ),
  );

/**
 * 全局维护任务(刷 `global_token_ref_index`)。**不带 userId** —— 这张表跟任何用户无关
 * (ADR 0022),所以 per-user 的那三张 store 压根不建。
 *
 * `R` 上是**两个端口**而不是一个服务:`warmRefIndex` / `refIndexRefreshedAt` 没有 Tag
 * (见 `@folio/oracle` 的 `ref-index.ts` —— 那个 Tag 从来没有被换过,只是仪式),
 * 于是这里少一层 `Layer.provide(refIndexWarmerLayer, …)` 嵌套,直接把端口喂进去。
 */
export const runOracleWarm = <A>(
  effect: Effect.Effect<A, UpstreamError, GlobalTokenRefIndexStore | TokenUpstream>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.merge(
          Layer.provide(globalTokenRefIndexStoreLayer, databaseLayer(env)),
          coinGeckoTokenUpstreamLayer(cgConfig()),
        ),
      ),
      Effect.provide(logTapeLogger),
      Effect.mapError(toError),
    ),
  );
