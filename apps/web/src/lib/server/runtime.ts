import { env } from "cloudflare:workers";
import {
  Database,
  type DbClient,
  type DbRequest,
  type GlobalDatabase,
  provideCurrentUser,
  provideDbClient,
} from "@folio/db";
import type { OracleServices } from "@folio/oracle";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { JsonResponse } from "@/lib/core/json-response";
import { ConnectorRegistry } from "./connectors/registry";
import { logCategory, logTapeLogger } from "./effect-log";
import { type AppError, toError } from "./errors";
import { oracleServices } from "./oracle";
import { withSpanTree } from "./tracing";

/**
 * 给 server fn 补一行 info 级的 handler + 耗时 —— TanStack 路径在 Workers 日志里是 REDACTED,靠这个排快慢。
 *
 * **`durationMs` 是 I/O 墙钟,不是 CPU。** 生产 workerd 里 `performance.now()` 在同步计算期间
 * 是冻住的(Spectre 缓解),只在 I/O 之后才前进 —— 所以这个数量的是「等 D1/出网等了多久」,
 * 纯计算再重它也可能是 0。CPU 只能看 Workers Logs 的 `cpuTime` 或一份 V8 profile(FOL-40 就是
 * 被这个字段误导过)。字段名不改:日志的消费方可能认它。
 */
const withServerFnTiming =
  <A, E extends AppError>(handler: string) =>
  (effect: Effect.Effect<A, E, UserServices>): Effect.Effect<A, E, UserServices> =>
    // **两处 `Effect.suspend` 都是必须的,别拆**:`.pipe(...)` 与 `Effect.ensuring(finalizer)` 的
    // 参数在**描述构建期**就同步求值 —— 若把 `startedAt` 和 `durationMs` 直接写在外面,两次
    // `performance.now()` 只差几微秒(都在构建那一瞬),`durationMs` 恒为 ~0,整个耗时日志失效。
    // 外层 suspend 把构建推迟到**执行期**,`startedAt` 落在真正的执行起点;finalizer 里再 suspend
    // 一次,`durationMs` 落在 finalizer 真正运行(handler 跑完)那一刻。两者之差才是真实耗时。
    Effect.suspend(() => {
      const startedAt = performance.now();
      return effect.pipe(
        Effect.annotateLogs({ handler }),
        Effect.ensuring(
          Effect.suspend(() =>
            Effect.logInfo("server fn").pipe(
              logCategory("server-fn"),
              Effect.annotateLogs({
                handler,
                durationMs: Number((performance.now() - startedAt).toFixed(1)),
              }),
            ),
          ),
        ),
      );
    });

// **server fn 与 cron 的运行时**:服务图在这里装配,也在这里跑起来。全仓只有这一份。
//
// 它不住 `oracle.ts` —— 那个文件是**参考层的装配点**(全仓唯一同时认识 D1 store 与 CoinGecko
// adapter 的地方),跟「怎么跑起来」是两件事。

/**
 * **每个 isolate 建一次的那张服务图**(ADR 0054)。
 *
 * 三张门票(`Database` / 参考层 / `ConnectorRegistry`)+ cron 那张不带 user 的(`GlobalDatabase`)
 * + 日志转发器。(刷全局映射表的门面以前也在这里,FOL-85 挪去了 GitHub Actions,ADR 0056。)
 * **里面没有一样是某个请求、某个用户的**:db 的 op 在跑的
 * 那一刻才从 context 里取连接与用户,参考层与 connector 建的时候只抓门票、上游和部署级的 env。
 * 这不是凭感觉 —— 每一片建的时候握着什么,ADR 0054 列了清单(没有 fiber、timer、I/O 句柄;
 * 那种东西跨请求用会撞上 Workers 的「不能替另一个请求做 I/O」)。
 *
 * **以前这张图每请求建一遍又拆一遍**(`userLayer(userId)` → `Effect.provide`):生产 profile 里
 * 最便宜的一个 server fn,Effect 那一块就占 5–7ms,而免费计划一次请求只有 10ms CPU。
 */
type IsolateServices = Database | OracleServices | ConnectorRegistry | GlobalDatabase;

const isolateLayer = (): Layer.Layer<IsolateServices> =>
  Layer.mergeAll(Database.Default, oracleServices(), ConnectorRegistry.Default, logTapeLogger);

/**
 * **惰性**:第一次有请求来才建,形状与 `session/auth.ts` 的 `getAuth()` 一样 —— 模块加载期什么都
 * 不跑(Workers 的启动 CPU 限制,CLAUDE.md / ADR 0045 §3)。这是本文件唯一的模块级可变状态。
 *
 * 从不 `dispose`:它活到 isolate 被回收为止,而它的 scope 里没有要收尾的东西(见上面的清单)。
 */
let isolate: ManagedRuntime.ManagedRuntime<IsolateServices, never> | undefined;
const isolateRuntime = () => {
  isolate ??= ManagedRuntime.make(isolateLayer());
  return isolate;
};

/**
 * 一个用户的全部服务 —— handler 的 `R` 只能落在这个范围里。**三张门票 + 一次请求的两样**
 * (`DbRequest`:这次是谁、那一个 D1 句柄),没有散装的端口。
 *
 * 参考层的那几片(代币行 / 价格行)**不在这里**,这是刻意的收窄(#504 T17):它们只在
 * `DatabaseForOracle` 上,而那张票只喂给 `@folio/oracle`。露出去等于给任何 handler 留一条
 * 绕过参考层直接改代币行和价格行的路。`user-services-surface.test.ts` 在类型层钉着这条。
 *
 * app 真的要直接用的那一片是 per-user 的 KV 缓存(DeFi 协议图,`logos/store.ts` —— 没有上游、
 * 不出网,不属于参考层)。它现在是 `Database` 的一个字段,不再是从参考层漏出来的一个端口。
 *
 * `ConnectorRegistry` 是第三张(#504 T14):它答的是「这个部署支持哪些上游、字段长什么样、
 * 这份凭据活不活」,与 userId 无关,但取用方式与另外两张一致。
 */
export type UserServices = Database | OracleServices | ConnectorRegistry | DbRequest;

/**
 * **「这段活是这个用户的」—— 一次请求要给的全部就是这两样。**
 *
 * 全仓给 user 的地方只有这个文件(`user-services-surface.test.ts` 按源码钉着):`CurrentUser`
 * 的 Tag 不出 `@folio/db`,包外唯一的给法是 `provideCurrentUser`,而 app 里只有这里许写它。
 *
 * **一次请求一个 `DbClient`(ADR 0045 §3 的红线,原样)**:这个组合子套一次,effect 跑一次,
 * 就建一个句柄,这段活里的每个 op —— `Database` 上的、参考层那张票上的 —— 读到的都是它。
 */
const asUser =
  (userId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(provideCurrentUser(userId), provideDbClient(env));

// 一个用户的活:给这个用户的两样、错误映射、挂上下文。**顺序是有讲究的** —— 注解挂在给值的
// **外面**,所以连那一步本身打的日志也带得上;挂在里面就只覆盖被包住那段。
// 出口的 `R` 是 isolate 的那张图,由跑它的边缘给(下面 `runForUser` 直接跑在运行时上,
// `forUser` 自己 provide 那个运行时)。
const inRequest = <A, E extends AppError>(
  userId: string,
  effect: Effect.Effect<A, E, UserServices>,
): Effect.Effect<A, Error, IsolateServices> =>
  effect.pipe(
    asUser(userId), // ← 注入发生在这一行
    Effect.mapError(toError), // ← 失败变成人话的唯一一处(见 ./errors)
    Effect.annotateLogs({ userId }),
    Effect.annotateSpans({ userId }),
  );

/**
 * **一个用户的活儿,装配好了但还没跑。**
 *
 * cron 那条路要的就是这个形状:它把 N 个用户拼进**自己那一个** effect,只在最外面跑一次
 * (`runAtEdge`)。给它一个 Promise 等于逼它在中途切一道边界。
 *
 * **自带服务图**:它把 isolate 运行时 provide 进去(建好之后就是一次 context 合并),所以调用方
 * 拿到的是一个什么都不缺的 effect —— 逐用户拼接、逐用户兜错都不必知道底下有一个运行时。
 * 每个用户各自一次 `asUser`:一个用户一个 `DbClient`,谁的 op 读到的就是谁。
 */
export const forUser = <A, E extends AppError>(
  userId: string,
  effect: Effect.Effect<A, E, UserServices>,
): Effect.Effect<A, Error> => Effect.provide(inRequest(userId, effect), isolateRuntime());

/**
 * **发动点** —— 在 `forUser` 之上补只有「跑」才需要的:span 树。
 *
 * 路由 / 测试 / 需要显式 userId 的 server fn 都走这里。server fn 的标准装配另有
 * `runEffect`,在它之上再挂 `handler` 日志注解。
 *
 * 两条路唯一的差别是**「谁认的人」** —— server fn 有 `requireAuth` 中间件把 userId 放进
 * context,路由自己调 `resolveAuth`。认完之后要做的事一模一样,所以只能有一份。
 *
 * 路由侧的身份看 `Effect.fn` 的 span 名(Cause / 树里都有),不再另传一个字符串进日志。
 * 日志层不必再每请求 provide 一次:它在 isolate 运行时里(`logTapeLogger` 落在运行时的
 * FiberRef 初值上,每次 `runPromise` 从那儿起跑)。
 */
export const runForUser = <A, E extends AppError>(
  userId: string,
  effect: Effect.Effect<A, E, UserServices>,
): Promise<A> =>
  // 一次请求一棵 span 树(#504 T16)—— **只在 `LOG_LEVEL` 为 debug 时装**(理由见 tracing.ts
  // 「开销与开关」)。装在这儿而不是 `forUser` 里:cron 那条路把 N 个用户拼成**一个** effect,
  // 树该按那一整趟算,由它自己的边缘装(`runAtEdge`)。
  isolateRuntime().runPromise(withSpanTree(inRequest(userId, effect)));

/** `runEffect` 的 timing 壳,给必须走 `runForUser` 的 server fn(如 syncAccount)复用。 */
export const runTimedForUser = <A, E extends AppError>(
  userId: string,
  handler: string,
  effect: Effect.Effect<A, E, UserServices>,
): Promise<A> => runForUser(userId, withServerFnTiming<A, E>(handler)(effect));

/**
 * **server fn 的发动点 —— handler 只描述,这里负责跑。**
 *
 * handler 拿到的只有 `data`,返回一个 Effect;要什么服务写在它的 `R` 通道里(`yield* Database`)。
 * 「哪个用户」「怎么装配」「错误怎么映射」「什么时候变成 Promise」全部发生在 `runForUser` 里,
 * handler 一个字都不必知道 —— 它连 `context` 都收不到,所以也不可能自己去读 userId 拼查询。
 *
 * 用法(装配点):`.handler(runEffect(handleCreateTabPin))`。
 *
 * **关键是方向。** 迁移中那阵子发动点由 handler 自己调,于是每个 handler 都是「一半业务 +
 * 一半运行时」;现在由装配点调,handler 那半干净了 —— review 一个 handler 不再需要顺手检查
 * 它的发动、注入、错误映射写没写对。
 *
 * `handler` 日志注解只在这边加:**`Effect.fn("createTabPin")` 会把这个名字写进函数的 `name`**
 * (实测确认),所以白拿 —— 装配点不必再手写一遍,也不会跟 span 名字对不上。没包 `Effect.fn`
 * 的拿到的是声明名 `handleXxx`,一样够用;压缩会把那种名字改掉,而 `Effect.fn` 那种是字符串
 * 常量,压不动 —— 这也是 T7 起要求每个 handler 都包 `Effect.fn` 的理由之一。
 */
export const runEffect =
  <D, A, E extends AppError>(handler: (data: D) => Effect.Effect<A, E, UserServices>) =>
  // `context` 只声明用得着的那个字段:`requireAuth` 注入的是整个 `AuthContext`(还带 user /
  // session),而这里唯一该碰的就是 userId。少声明一个字段 = 少一条能悄悄用起来的路。
  ({ data, context }: { data: D; context: { userId: string } }): Promise<A> => {
    const name = handler.name || "anonymous";
    const effect = withServerFnTiming<A, E>(name)(handler(data));
    return runForUser(context.userId, effect);
  };

/**
 * `runEffect` 的「原样 JSON」出口(FOL-92,理由见 `@/lib/core/json-response`):结果用引擎原生的
 * `JSON.stringify` 写成一个 `Response`,不经 seroval 逐节点序列化。浏览器侧用 `readJson` 解。
 *
 * **只给返回纯 JSON 的读接口用。** 失败那条路与 `runEffect` 完全相同(还没走到造 Response 就抛了)。
 * `cache-control` 不在这里写:入口的 `withDefaultNoStore` 对每个响应都补(`entry/cache-headers.ts`)。
 */
export const runEffectJson =
  <D, A, E extends AppError>(handler: (data: D) => Effect.Effect<A, E, UserServices>) =>
  async (ctx: { data: D; context: { userId: string } }): Promise<JsonResponse<A>> => {
    const value = await runEffect(handler)(ctx);
    return new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    }) as JsonResponse<A>;
  };

// —— 不带 user 的那半(cron)——

/**
 * **系统级(无 userId)的活** —— cron 枚举用户。原则 #6 的受控例外。
 *
 * 只给一个连接(外加服务图):这些 op 在 `GlobalDatabase` 上,`R` 里
 * 压根没有 `CurrentUser`,所以不必(也不许)假造一个用户。
 */
export const withGlobalDb = <A, E>(
  effect: Effect.Effect<A, E, GlobalDatabase | DbClient>,
): Effect.Effect<A, E> => Effect.provide(provideDbClient(env)(effect), isolateRuntime());

/**
 * 边缘:跑一个**已经装配好**的 cron effect。cron 一次调用只经这里一次,跑在与 server fn 同一个
 * isolate 运行时上(日志层在那里)。
 */
export const runAtEdge = <A>(effect: Effect.Effect<A, Error>): Promise<A> =>
  // span 树也在这儿装(#504 T16):cron 一次调用就是一趟,那棵树该按整趟算。
  // 同样只在 `LOG_LEVEL` 为 debug 时装(见 tracing.ts「开销与开关」)。
  isolateRuntime().runPromise(withSpanTree(effect));
