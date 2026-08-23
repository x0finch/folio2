import { env } from "cloudflare:workers";
import type { UpstreamError } from "@folio/client-core";
import {
  AccountStore,
  CurrentUser,
  Database,
  type DbClient,
  dbClientLayer,
  globalTokenRefIndexStoreLayer,
  ManualStore,
  oraclePortsLayer,
  PortfolioStore,
  SettingsStore,
  SnapshotStore,
  TagStore,
  TransferStore,
} from "@folio/db";
import {
  GlobalRefIndexService,
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
import { type Context, Effect, Layer } from "effect";
import { logTapeLogger } from "./effect-log";

// 参考层的装配点(ADR 0023,#199/#200)。**这是全仓唯一同时认识两边的文件** ——
// 一边是 D1 store,一边是 CoinGecko adapter;`@folio/oracle` 自己两边都不认识。
//
// #362 第 4 站之后这里给的是 **Layer**,不再是 `createOracleFor({ 七个工厂回调 })`。
// 少掉的东西:七个 `createXxx(userId)` 字段、`overrides` 的转手(adapter 的 layer 自己给
// `Namer`)、`onWarn` 回调(改 Effect 日志 + 下面那个转发器)、`now`(改 `Clock`)。
//
// **一次请求一次装配,不是一次调用一次。** 调用方拿到的是「装配」(`withRequest`/`withOracleWarm`)
// 与「跑」(`runAtEdge`)两半。以前是每个方法调用各自 await 一个 Promise,层与层之间没有共同的
// 上下文;现在超时与中断能一路传到最底层那发 fetch。cron 更进一步:整趟(sweep + 逐用户预热)
// 拼成一个 effect,只在 `waitUntil` 那儿跑一次。
//
// (`runPromise` 现在有两处:这里的 `runAtEdge`,和 `runtime.ts` 的 `runEffect` —— 后者是
// server fn 那条路的唯一发动点。没迁的 handler 还走这里,#504 T13 之后就只剩那一处。)

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

// per-user 的三张 store + 那张全局表,都由 `@folio/db` 直接给 Layer(#362 第 5 站)——
// 以前这里还有一层 30 行的 `Effect.promise` 适配(`oracle-ports.ts`),因为 db 那边是 Promise 形状;
// 现在四个 store 自己就是 Effect,那个文件删了,`env` 也只在 `dbClientLayer(env)` 一处被读。
//
// 惰性到「只建被用到的那一个」这件事**不做**:`packages/db/src/connect.ts` 自己写着
// 「drizzle(env.DB) 很轻,每次创建即可」,而现在四个 store 共用同一个 `DbClient`——
// 建它们只是几个闭包。迁移前那套 getter + `??=` 的手写惰性,省下的是不存在的代价。
//
// 四个端口现在是 db 出的**一张** layer(#504 T5)。这里只剩「按谁跑」这一件事要补 ——
// 端口有几个、叫什么名字,装配点不必知道。
const portsFor = (perRequest: Layer.Layer<DbClient | CurrentUser>) =>
  Layer.provide(oraclePortsLayer({ namer: UPSTREAM_ID }), perRequest);

// cron 刷全局映射表只要这两个端口 —— 没有 userId,也不建 per-user 那三张。
const warmPorts = () =>
  Layer.merge(
    Layer.provide(globalTokenRefIndexStoreLayer, dbClientLayer(env)),
    coinGeckoTokenUpstreamLayer(cgConfig()),
  );

// `provideMerge` 而不是 `provide`:端口也透出去。app 自己有一小片直接用 `CacheStore`
// (DeFi 协议图 —— 没有上游、不属于参考层,见 `logos/store.ts`),而这些端口本来就是
// 这个文件建的,没必要为了用它们再包一个服务。
// **`dbClient` 是必填,没有默认值。** 它出包给 `runtime.ts` 用之后,一个 `= dbClientLayer(env)`
// 的默认值就等于「不传也能跑」—— 而不传正好就是多开一条连接那种写法。红线要靠签名挡住,
// 不能靠调用点记得。
export const oracleFor = (perRequest: Layer.Layer<DbClient | CurrentUser>) =>
  Layer.provideMerge(oracleLayer, Layer.merge(portsFor(perRequest), upstreams()));

// 类型化的失败 → 普通 `Error`。**不让 `FiberFailure` 漏给调用方**:`runPromise` 默认抛的是它,
// 而 `Data.TaggedError` 的那四类没有 `message` 字段,于是上层日志里只剩一个空消息 + 一坨 Cause。
// 消息里只有 tag、pathname 和状态码 —— `where` 本来就刻意不带 query(原则 #5 红线)。
export const toError = (error: UpstreamError | Error): Error =>
  isUpstream(error)
    ? new Error(
        `${error.upstream} ${error._tag} on ${error.where}${
          error.status !== undefined ? ` (${error.status})` : ""
        }`,
        { cause: error },
      )
    : error;

// **不能用 `instanceof Error` 区分** —— `Data.TaggedError` 造出来的类自己就 extends Error,
// 两边都是 true。按 `upstream` 这个字段判:四类上游错误都有它,普通 `Error` 没有。
// (判 `_tag` 那条约定说的是「同类之间怎么分」;这里分的是「是不是这一类」。)
const isUpstream = (error: UpstreamError | Error): error is UpstreamError => "upstream" in error;

/**
 * 全局维护任务(刷 `global_token_ref_index`)的装配。**不带 userId** —— 这张表跟任何用户无关
 * (ADR 0022),所以 per-user 的那三张 store 压根不建;只装 `GlobalRefIndexService` + 它要的
 * 两个端口。
 */
export const withOracleWarm = <A>(
  effect: Effect.Effect<A, UpstreamError, GlobalRefIndexService>,
): Effect.Effect<A, Error> =>
  effect.pipe(
    Effect.provide(Layer.provide(GlobalRefIndexService.Default, warmPorts())),
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
// 参考层的四张 store 在上面 `portsFor`;这里是 db 的八个领域服务。**两边共用同一份
// `DbClient`** —— 一次请求一个 drizzle 句柄,不是每个 store 一个,也不是每半边一个。
//
// 「共用」有两个条件,缺一不可:
//   ① 三边收到的是**同一个 layer 引用**(所以 `dbClient` 是参数,不是各自现建)
//   ② 它们在**同一次 `Effect.provide`** 里被建起来 —— Layer memoisation 的作用域是一次构建,
//      分两次 provide 就是两份,哪怕引用相同。见下面 `requestLayer`。
//
const dbStoresFor = (perRequest: Layer.Layer<DbClient | CurrentUser>): Layer.Layer<DbStores> =>
  Layer.provide(
    Layer.mergeAll(
      AccountStore.Default,
      PortfolioStore.Default,
      SettingsStore.Default,
      SnapshotStore.Default,
      ManualStore.Default,
      TagStore.Default,
      TransferStore.Default,
    ),
    perRequest,
  );

/**
 * app 数据那半**还没挂进聚合 `Database`** 的领域服务 —— server fn 的 `R` 里出现的就是这些。
 *
 * **这个联合只会变短**:每次一个领域挂进聚合(#504 T7–T12),它就从这里少一个;最后一个搬完
 * 这个类型和 `dbStoresFor` 一起删掉,`requestLayer` 里 db 那半只剩 `Database`。
 * tab-pins 已经这样退场了(T1 打样)。
 */
export type DbStores =
  | AccountStore
  | PortfolioStore
  | SettingsStore
  | SnapshotStore
  | ManualStore
  | TagStore
  | TransferStore;

/**
 * **过渡期的装配** —— 目标形状那份是 `runtime.ts` 的 `userLayer`,这份多带一样东西:
 * 那批**还没挂进聚合 `Database`** 的旧领域 Tag。
 *
 * 还留着是因为它还有真消费者:`withRequest`(四处没迁的 handler)与 sync 的 `syncFor`。
 * 每迁完一批(#504 T7–T12)`DbStores` 就短一截,最后一批迁完这个函数、`dbStoresFor`、
 * `withRequest`/`runRequest`/`runStore` 一起删(T13),只剩 `userLayer`。
 *
 * **流**那条路(`/api/sync` 把同步的流交给 `Stream.provideLayer`)拿不到 effect 形状的包装,
 * 只能要 layer 本身,所以这里出的是 layer 不是 effect。
 */
export const legacyRequestLayer = (userId: string): Layer.Layer<RequestServices> => {
  // **一次 provide,不是三次。** 三边各 provide 一次的话,同一个 `dbClient` 引用也会被建三遍
  // (memoisation 的作用域是一次构建),于是一个请求握着三个 drizzle 句柄 —— 今天只是浪费,
  // 但 `DbClient` 一旦长出状态(span、慢查询计数,`@folio/db` 的 `client.ts` 已记着要加),
  // 那就是悄悄劈成几半的状态。
  const perRequest = perRequestLayer(userId);
  return Layer.mergeAll(
    Layer.provide(Database.Default, perRequest),
    dbStoresFor(perRequest),
    oracleFor(perRequest),
  );
};

/** 过渡期的服务面 —— 比 `UserServices` 多一个 `DbStores`,那部分只会变少。 */
export type RequestServices = Database | DbStores | OracleServices | OraclePorts;

export const withRequest = <A, E extends UpstreamError | Error>(
  userId: string,
  effect: Effect.Effect<A, E, RequestServices>,
): Effect.Effect<A, Error> => {
  return effect.pipe(Effect.provide(legacyRequestLayer(userId)), Effect.mapError(toError));
};

/**
 * 一步式:装配 + 立刻跑。server fn / route handler 那种「一次请求就问一次」的路径用它 ——
 * 请求本身就是边缘,没有可拼的下一步。要把多步拼成一个再跑的(cron),用 `withRequest` + `runAtEdge`。
 */
export const runRequest = <A, E extends UpstreamError | Error>(
  userId: string,
  effect: Effect.Effect<A, E, RequestServices>,
): Promise<A> => runAtEdge(withRequest(userId, effect));

/**
 * 「一次 store 调用就完事」的 server fn 用它 —— `runRequest(u, Effect.flatMap(Tag, f))` 的短写。
 *
 * 不是第二条路(底下就是 `runRequest`),只是**二十多个 CRUD 薄壳**里那句 `Effect.flatMap` 的
 * 噪音收成一处:`runStore(userId, TagStore, (s) => s.list())` 与它替掉的 `db.listTagsByUser(userId)`
 * 一样长,而这一句里 userId 只出现在装配那一处 —— 那正是 ADR 0037 要的。
 */
export const runStore = <I extends DbStores, S, A>(
  userId: string,
  tag: Context.Tag<I, S>,
  use: (service: S) => Effect.Effect<A>,
): Promise<A> => runRequest(userId, Effect.flatMap(tag, use));

/** 系统级(无 userId)的 db 查询 —— cron 枚举用户那一条。原则 #6 的受控例外。 */
export const withDbClient = <A>(effect: Effect.Effect<A, never, DbClient>): Effect.Effect<A> =>
  Effect.provide(effect, dbClientLayer(env));
