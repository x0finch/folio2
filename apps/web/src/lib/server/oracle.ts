import { env } from "cloudflare:workers";
import type { UpstreamError } from "@folio/client-core";
import {
  CurrentUser,
  type DbClient,
  dbClientLayer,
  globalTokenRefIndexStoreLayer,
  oraclePortsLayer,
} from "@folio/db";
import { GlobalRefIndexService, type OracleServices, oracleLayer } from "@folio/oracle";
import type { CacheStore } from "@folio/oracle-basic/ports";
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
// **这个文件里已经没有 per-user 的装配了**(#504 T13):`legacyRequestLayer` / `withRequest` /
// `runRequest` 连同它们那排旧域 Tag 一起退场,那件事整个搬去了 `runtime.ts`。剩下的两样都
// **与 userId 无关** —— cron 刷全局映射表的装配,和一个只补日志层的边缘。

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

/**
 * 参考层 + **它的端口里唯一该露在外面的那一个**(#504 T17)。
 *
 * `provideMerge` 而不是 `provide`:app 自己有一小片直接用 `CacheStore` —— DeFi 协议图
 *(`logos/store.ts`)。那份数据来自用户自己同步下来的余额 meta,没有上游、不出网,不属于参考层,
 * 但要一个 per-user 的键值缓存;而这个缓存本来就是这个文件建的,没必要为它再包一个服务。
 *
 * **返回类型只写 `OracleServices | CacheStore`,这不是偷懒是收窄。** 运行时这张 layer 里八个端口
 * 都在(`provideMerge` 把它们一并透出),但类型上只认得出两样 —— 于是
 * `TokenStore` / `TokenPriceStore` / `GlobalTokenRefIndexStore` 在 handler 那边**取不出来**,
 * 谁都没法绕过参考层直接改代币行和价格行。收窄靠类型而不是靠再建一层,是因为再建一层就会有
 * 第二个 `CacheStore` 实例:两个对象,同一张表,而 `provideMerge` 出去的那个必须与参考层
 * 内部用的是同一个。
 *
 * **`perRequest` 是必填,没有默认值。** 它出包给 `runtime.ts` 用之后,一个 `= dbClientLayer(env)`
 * 的默认值就等于「不传也能跑」—— 而不传正好就是多开一条连接那种写法。红线要靠签名挡住,
 * 不能靠调用点记得。
 */
export const oracleFor = (
  perRequest: Layer.Layer<DbClient | CurrentUser>,
): Layer.Layer<OracleServices | CacheStore> =>
  Layer.provideMerge(oracleLayer, Layer.merge(portsFor(perRequest), upstreams()));

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

/** 系统级(无 userId)的 db 查询 —— cron 枚举用户那一条。原则 #6 的受控例外。 */
export const withDbClient = <A>(effect: Effect.Effect<A, never, DbClient>): Effect.Effect<A> =>
  Effect.provide(effect, dbClientLayer(env));
