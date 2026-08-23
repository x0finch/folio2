import { env } from "cloudflare:workers";
import type { UpstreamError } from "@folio/client-core";
import {
  CurrentUser,
  DatabaseForOracle,
  type DbClient,
  dbClientLayer,
  GlobalDatabase,
} from "@folio/db";
import { GlobalRefIndexService, type OracleServices, oracleLayer } from "@folio/oracle";
import {
  coinGeckoFxUpstreamLayer,
  coinGeckoNamerLayer,
  coinGeckoPlatformUpstreamLayer,
  coinGeckoTokenUpstreamLayer,
  UPSTREAM_ID,
} from "@folio/oracle-upstream-coingecko";
import { Effect, Layer } from "effect";
import { logTapeLogger } from "./effect-log";
import { toError } from "./errors";
import { spanTracer } from "./tracing";

// 参考层的装配点(ADR 0023,#199/#200)。**这是全仓唯一同时认识两边的文件** ——
// 一边是 D1 store,一边是 CoinGecko adapter;`@folio/oracle` 自己两边都不认识。
//
// #362 第 4 站之后这里给的是 **Layer**,不再是 `createOracleFor({ 七个工厂回调 })`。
// 少掉的东西:七个 `createXxx(userId)` 字段、`overrides` 的转手(adapter 的 layer 自己给
// `Namer`)、`onWarn` 回调(改 Effect 日志 + 下面那个转发器)、`now`(改 `Clock`)。
//
// **一次请求一次装配,不是一次调用一次。** 调用方拿到的是「装配」(`withOracleWarm`)与
// 「跑」(`runAtEdge`)两半。以前是每个方法调用各自 await 一个 Promise,层与层之间没有共同的
// 上下文;现在超时与中断能一路传到最底层那发 fetch。cron 更进一步:整趟(sweep + 逐用户预热)
// 拼成一个 effect,只在 `waitUntil` 那儿跑一次。
//
// **这个文件里已经没有 per-user 的装配了**(#504 T13):那件事整个搬去了 `runtime.ts`。
// 剩下的两样都**与 userId 无关** —— cron 刷全局映射表的装配,和一个只补日志层的边缘。

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

/**
 * **一次请求的两样底料**:那一个 drizzle 句柄,和「这次请求是谁的」(ADR 0044)。
 *
 * 底下每一个 per-user 服务(db 的八个领域 + 参考层的三张 store)都不自己开连接、也不自己收
 * userId —— 它们的 `R` 声明 `DbClient | CurrentUser`,建自己那一刻各读一次。
 *
 * **一次请求只有一个 `DbClient`(红线)**:这里建一次,一个引用分给所有人,Effect 的 layer
 * memoisation 保证只建一次。分两次 provide 就是两份,哪怕引用相同。
 */
export const perRequestLayer = (userId: string): Layer.Layer<DbClient | CurrentUser> =>
  Layer.merge(dbClientLayer(env), Layer.succeed(CurrentUser, userId));

// 参考层要的本地那几片 —— **两张 db 门票**,不是一排端口(#504 T5 之后又收了一次:
// `oracle-ports/` 那个目录整个没了,契约就是 db 里的实现)。
//   · `DatabaseForOracle` 代币行 / 价格行 / 缓存,per-user
//   · `GlobalDatabase`    mint 要正查的那张全局映射表,没有 userId
//
// **`namer` 在这里传进去**:db 层不预设任何厂商(表名列名零 vendor 字样,#199),而凡是要按
// 命名者点查 `token_refs` 的读、以及历史日价那条全局键都要它。取 adapter 导出的常量,
// 不从 `Namer` 服务里 yield —— 那会让 db 反过来消费参考层的一个服务。
//
// **两张都喂 `perRequest`,不另开 `dbClientLayer(env)`** —— 一次请求一个 drizzle 句柄是红线。
// `GlobalDatabase` 不带 userId,不代表它可以自己再开一条连接;多给它一个 `CurrentUser` 无害
// (它根本不读)。
const dbForOracle = (perRequest: Layer.Layer<DbClient | CurrentUser>) =>
  Layer.merge(
    Layer.provide(DatabaseForOracle.Default(UPSTREAM_ID), perRequest),
    Layer.provide(GlobalDatabase.Default, perRequest),
  );

/**
 * **不带 userId 的那张 db 门票**(`GlobalDatabase`)。
 *
 * 全局映射表与「有哪些用户」这两条都住它上面 —— 判据是「表里有没有『谁的』这回事」,没有。
 * 它只要 `DbClient`,所以这里一行装配就够,不必先假造一个用户去建 per-user 的那一堆。
 */
const globalDbLayer = () => Layer.provide(GlobalDatabase.Default, dbClientLayer(env));

// cron 刷全局映射表要的两样 —— 那张门票 + 代币上游。
const warmDeps = () => Layer.merge(globalDbLayer(), coinGeckoTokenUpstreamLayer(cgConfig()));

/**
 * 参考层,装好、封住 —— 出去的只有它那三个域服务。
 *
 * **`provide` 而不是 `provideMerge`(#504 T17 那道收窄,现在是结构性的)**:代币行与价格行
 * 现在住 `DatabaseForOracle`,这张 layer 把它喂进参考层之后就**不再往外透**。以前这里必须靠
 * 「返回类型写窄一点」来挡 handler,运行时那几个端口其实都还在 context 上;现在挡它的是装配
 * 本身。app 要的那片 KV 缓存不再从这儿漏 —— 它在 `Database` 上(`db.cache`)。
 *
 * **`perRequest` 是必填,没有默认值。** 它出包给 `runtime.ts` 用之后,一个 `= dbClientLayer(env)`
 * 的默认值就等于「不传也能跑」—— 而不传正好就是多开一条连接那种写法。红线要靠签名挡住,
 * 不能靠调用点记得。
 */
export const oracleFor = (
  perRequest: Layer.Layer<DbClient | CurrentUser>,
): Layer.Layer<OracleServices> =>
  Layer.provide(oracleLayer, Layer.merge(dbForOracle(perRequest), upstreams()));

/**
 * 全局维护任务(刷 `global_token_ref_index`)的装配。**不带 userId** —— 这张表跟任何用户无关
 * (ADR 0022),所以 per-user 的那三张 store 压根不建;只装 `GlobalRefIndexService` +
 * 它要的那张门票与那个上游。
 */
export const withOracleWarm = <A>(
  effect: Effect.Effect<A, UpstreamError, GlobalRefIndexService>,
): Effect.Effect<A, Error> =>
  effect.pipe(
    Effect.provide(Layer.provide(GlobalRefIndexService.Default, warmDeps())),
    Effect.mapError(toError),
  );

/**
 * 边缘:跑一个**已经装配好**的 effect,只补日志层。cron 一次调用只经这里一次。
 *
 * `runPromise` 仍然只在本文件出现 —— 上面那两个 `with*` 负责装配,这里负责跑,调用方两者
 * 各取所需,但都不会自己拿到 `Effect.runPromise`。
 */
export const runAtEdge = <A>(effect: Effect.Effect<A, Error>): Promise<A> =>
  // span 树也在这儿装(#504 T16):cron 一次调用就是一趟,那棵树该按整趟算。
  Effect.runPromise(effect.pipe(Effect.provide(logTapeLogger), Effect.provide(spanTracer)));

/** 系统级(无 userId)的 db 查询 —— cron 枚举用户那一条。原则 #6 的受控例外。 */
export const withGlobalDb = <A>(
  effect: Effect.Effect<A, never, GlobalDatabase>,
): Effect.Effect<A> => Effect.provide(effect, globalDbLayer());
