import { env } from "cloudflare:workers";
import type { UpstreamError } from "@folio/client-core";
import {
  type AccountStore,
  accountStoreLayer,
  databaseLayer,
  globalTokenRefIndexStoreLayer,
  type ManualStore,
  manualStoreLayer,
  type PortfolioStore,
  portfolioStoreLayer,
  type SettingsStore,
  type SnapshotStore,
  settingsStoreLayer,
  snapshotStoreLayer,
  type TabPinStore,
  type TagStore,
  type TransferStore,
  tabPinStoreLayer,
  tagStoreLayer,
  transferStoreLayer,
  userCacheStoreLayer,
  userTokenPriceStoreLayer,
  userTokenStoreLayer,
} from "@folio/db";
import {
  type GlobalRefIndexService,
  globalRefIndexServiceLayer,
  type OraclePorts,
  type OracleServices,
  oracleLayer,
} from "@folio/oracle";
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
// **`runPromise` 只在这里出现**:调用方拿到的是「装配」(`withOracle`/`withOracleWarm`)与
// 「跑」(`runAtEdge`)两半,或者两者合一的 `runOracle`。以前是每个方法调用各自 await 一个
// Promise,层与层之间没有共同的上下文;现在一次请求一次装配,超时与中断能一路传到最底层那发 fetch。
// cron 更进一步:整趟(sweep + 逐用户预热)拼成一个 effect,只在 `waitUntil` 那儿跑一次。

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

// cron 刷全局映射表只要这两个端口 —— 没有 userId,也不建 per-user 那三张。
const warmPorts = () =>
  Layer.merge(
    Layer.provide(globalTokenRefIndexStoreLayer, databaseLayer(env)),
    coinGeckoTokenUpstreamLayer(cgConfig()),
  );

// `provideMerge` 而不是 `provide`:端口也透出去。app 自己有一小片直接用 `CacheStore`
// (DeFi 协议图 —— 没有上游、不属于参考层,见 `defi-logo-store.ts`),而这些端口本来就是
// 这个文件建的,没必要为了用它们再包一个服务。
const oracleFor = (userId: string) =>
  Layer.provideMerge(oracleLayer, Layer.merge(portsFor(userId), upstreams()));

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
 * 给一个 effect 装上参考层,**但不跑它**。
 *
 * 有了它,调用方才能把「多个用户的多步预热」先拼成**一个** effect,再在最边缘跑一次 —— 这正是
 * Effect 官方那句「把大部分逻辑写成 Effect,`run*` 尽量放在程序的边缘」。中间每步各 `runPromise`
 * 一次,层与层之间就没有共同的上下文:超时、中断、日志的 fiber 上下文全在每个边界上断一次。
 *
 * 参考层装的是**用户私有**数据(他认识哪些币、他的币叫什么名),拿错用户就是数据泄露 ——
 * 所以 userId 是必填参数,而服务的方法签名里一个 user 参数都没有:拿错在编译期就发生不了。
 * cron 没有 auth 上下文,得逐用户各装一次,那正是本签名想让它显而易见的事。
 */
export const withOracle = <A>(
  userId: string,
  effect: Effect.Effect<A, UpstreamError, OracleServices | OraclePorts>,
): Effect.Effect<A, Error> =>
  effect.pipe(Effect.provide(oracleFor(userId)), Effect.mapError(toError));

/**
 * 全局维护任务(刷 `global_token_ref_index`)的装配。**不带 userId** —— 这张表跟任何用户无关
 * (ADR 0022),所以 per-user 的那三张 store 压根不建;只装 `GlobalRefIndexService` + 它要的
 * 两个端口。
 */
export const withOracleWarm = <A>(
  effect: Effect.Effect<A, UpstreamError, GlobalRefIndexService>,
): Effect.Effect<A, Error> =>
  effect.pipe(
    Effect.provide(Layer.provide(globalRefIndexServiceLayer, warmPorts())),
    Effect.mapError(toError),
  );

/**
 * 边缘:跑一个**已经装配好**的 effect,只补日志层。cron 一次调用只经这里一次。
 *
 * `runPromise` 仍然只在本文件出现 —— 上面那两个 `with*` 负责装配,这里负责跑,调用方两者
 * 各取所需,但都不会自己拿到 `Effect.runPromise`。
 */
export const runAtEdge = <A>(effect: Effect.Effect<A, Error>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(logTapeLogger)));

// —— 应用数据那半的 per-user 服务(ADR 0037,#394 T4)——
//
// 参考层的四张 store 在上面 `portsFor`;这里是 db 的八个领域服务。**同一个 `databaseLayer(env)`**
// 喂给两边 —— 一次请求一个 drizzle 句柄,不是每个 store 一个。
//
// `TransferStore` 的 layer 还要另外两个 store(导快照/导活动调它们的写口),所以先合出 base
// 再把它 provide 上去。
const dbStoresFor = (userId: string) => {
  const base = Layer.mergeAll(
    accountStoreLayer(userId),
    portfolioStoreLayer(userId),
    settingsStoreLayer(userId),
    snapshotStoreLayer(userId),
    manualStoreLayer(userId),
    tagStoreLayer(userId),
    tabPinStoreLayer(userId),
  );
  return Layer.provide(
    Layer.merge(base, Layer.provide(transferStoreLayer(userId), base)),
    databaseLayer(env),
  );
};

/** app 数据那半的全部服务 —— server fn 的 `R` 里出现的就是这些。 */
export type DbStores =
  | AccountStore
  | PortfolioStore
  | SettingsStore
  | SnapshotStore
  | ManualStore
  | TagStore
  | TabPinStore
  | TransferStore;

/**
 * **一次请求一次装配** —— 参考层 + app 数据两边一起装。
 *
 * 这是 #394 要达成的形状:一个 server fn 里连着读账户、问价、读快照、写活动,走的是同一份
 * context;以前是每问一次各 `runPromise` 一次(一个总览请求切两次 Effect 边界、建两套 store)。
 * Effect 官方那句「`run*` 尽量放在程序的边缘」在 server fn 这条路上就是这个形状:
 * 边缘是 handler 本身,再往里一次都不切。
 */
export const withRequest = <A>(
  userId: string,
  effect: Effect.Effect<A, UpstreamError, OracleServices | OraclePorts | DbStores>,
): Effect.Effect<A, Error> =>
  effect.pipe(
    Effect.provide(dbStoresFor(userId)),
    Effect.provide(oracleFor(userId)),
    Effect.mapError(toError),
  );

/**
 * 一步式:装配 + 立刻跑。server fn / route handler 那种「一次请求就问一次」的路径用它 ——
 * 请求本身就是边缘,没有可拼的下一步。要把多步拼成一个再跑的(cron),用 `withOracle` + `runAtEdge`。
 */
export const runOracle = <A>(
  userId: string,
  effect: Effect.Effect<A, UpstreamError, OracleServices | OraclePorts>,
): Promise<A> => runAtEdge(withOracle(userId, effect));
