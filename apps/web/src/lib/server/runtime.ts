import { Database } from "@folio/db";
import type { OracleServices } from "@folio/oracle";
import { Effect, Layer } from "effect";
import { ConnectorRegistry } from "./connectors/registry";
import { logCategory, logTapeLogger } from "./effect-log";
import { type AppError, toError } from "./errors";
import { oracleFor, perRequestLayer } from "./oracle";
import { spanTracer } from "./tracing";

/** 给 server fn 补一行 info 级的 handler + 耗时 —— TanStack 路径在 Workers 日志里是 REDACTED,靠这个排快慢。 */
const withServerFnTiming =
  <A, E extends AppError>(handler: string) =>
  (effect: Effect.Effect<A, E, UserServices>): Effect.Effect<A, E, UserServices> => {
    const startedAt = performance.now();
    return effect.pipe(
      Effect.annotateLogs({ handler }),
      Effect.ensuring(
        Effect.logInfo("server fn").pipe(
          logCategory("server-fn"),
          Effect.annotateLogs({
            handler,
            durationMs: Number((performance.now() - startedAt).toFixed(1)),
          }),
        ),
      ),
    );
  };

// **server fn 的运行时**:一次请求要的服务在这里装配,也在这里跑起来。全仓只有这一份。
//
// 它不住 `oracle.ts` —— 那个文件是**参考层的装配点**(全仓唯一同时认识 D1 store 与 CoinGecko
// adapter 的地方),跟「server fn 怎么跑起来」是两件事。

/**
 * 一次请求要的**全部服务**,作为一个 Layer。
 *
 * **出口是因为流那条路要它**(#504 T12):`/api/sync` 把同步交给 `Stream.provideLayer`,
 * 拿不到 effect 形状的包装,只能要 layer 本身。别的调用点一律走下面两个发动点。
 *
 * **全仓只有这一份 per-user 装配**(#504 T13)。
 *
 * **一次请求只有一个 `DbClient`(红线)**:聚合与参考层的四个端口都**不自己开连接**、也都不自己
 * 收 userId —— 它们的 `R` 声明 `DbClient | CurrentUser`,由 `perRequestLayer(userId)` 一次给上
 * (ADR 0044)。那一份建一次、一个引用分给两边,Effect 的 layer memoisation 保证只建一次。
 *
 * **边界是「一次构建」,不是「一次 `Layer.provide`」**(实测,见 `packages/db/tests/
 * one-db-client.test.ts`):同一张图里 `Layer.provide` 两次仍然共用一份,memo 表按构建走。
 * 真会变成两份的是**第二次构建** —— 另一次 `Effect.provide`,或者另起一条根 fiber
 * (根 fiber 不继承外层的 provide,#504 T12 在日志层上撞的是同一件事)。
 */
export const userLayer = (userId: string): Layer.Layer<UserServices> => {
  const perRequest = perRequestLayer(userId);
  return Layer.mergeAll(
    Layer.provide(Database.Default, perRequest),
    oracleFor(perRequest),
    // connector 那张门票**不带 userId**(它答的是「这个部署支持哪些上游、字段长什么样」),
    // 所以它不进 `perRequest`,只是一并挂在这次请求的 context 上(#504 T14)。
    ConnectorRegistry.Default,
  );
};

/**
 * 一个用户的全部服务 —— handler 的 `R` 只能落在这个范围里。**三张门票,没有散装的端口。**
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
export type UserServices = Database | OracleServices | ConnectorRegistry;

/**
 * **一个用户的活儿,装配好了但还没跑。**
 *
 * cron 那条路要的就是这个形状:它把 N 个用户拼进**自己那一个** effect,只在最外面跑一次
 * (`server.ts` 的 `runAtEdge`)。给它一个 Promise 等于逼它在中途切一道边界。
 *
 * 三件事在这里做完:注入、错误映射、挂上下文。**顺序是有讲究的** —— 注解挂在 `provide`
 * **外面**,所以连装配本身打的日志也带得上;挂在里面就只覆盖被包住那段。
 *
 * span 那半今天落在 no-op tracer 上(#504 T16 才装真的),但注解写在这里不多花什么,
 * 而装上之后「这个请求是谁的」立刻就在 span 树里 —— 不必再回头改一遍全部 handler。
 */
export const forUser = <A, E extends AppError>(
  userId: string,
  effect: Effect.Effect<A, E, UserServices>,
): Effect.Effect<A, Error> =>
  effect.pipe(
    Effect.provide(userLayer(userId)), // ← 注入发生在这一行
    Effect.mapError(toError), // ← 失败变成人话的唯一一处(见 ./errors)
    Effect.annotateLogs({ userId }),
    Effect.annotateSpans({ userId }),
  );

/**
 * **发动点** —— 在 `forUser` 之上补两件只有「跑」才需要的:日志层、span 树。
 *
 * 路由 / 测试 / 需要显式 userId 的 server fn 都走这里。server fn 的标准装配另有
 * `runEffect`,在它之上再挂 `handler` 日志注解。
 *
 * 两条路唯一的差别是**「谁认的人」** —— server fn 有 `requireAuth` 中间件把 userId 放进
 * context,路由自己调 `resolveAuth`。认完之后要做的事一模一样,所以只能有一份。
 *
 * 路由侧的身份看 `Effect.fn` 的 span 名(Cause / 树里都有),不再另传一个字符串进日志。
 */
export const runForUser = <A, E extends AppError>(
  userId: string,
  effect: Effect.Effect<A, E, UserServices>,
): Promise<A> =>
  forUser(userId, effect).pipe(
    Effect.provide(logTapeLogger),
    // 一次请求一棵 span 树(#504 T16)。装在这儿而不是 `forUser` 里:cron 那条路把 N 个用户
    // 拼成**一个** effect,树该按那一整趟算,由它自己的边缘装(见 server.ts)。
    Effect.provide(spanTracer),
    Effect.runPromise,
  );

/** `runEffect` 的 timing 壳,给必须走 `runForUser` 的 server fn(如 syncAccount)复用。 */
export const runTimedForUser = <A, E extends AppError>(
  userId: string,
  handler: string,
  effect: Effect.Effect<A, E, UserServices>,
): Promise<A> => runForUser(userId, withServerFnTiming(handler)(effect));

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
