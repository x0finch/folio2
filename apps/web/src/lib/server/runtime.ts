import { Database } from "@folio/db";
import type { OracleServices } from "@folio/oracle";
import type { CacheStore } from "@folio/oracle-basic/ports";
import { Effect, Layer } from "effect";
import { logTapeLogger } from "./effect-log";
import { type AppError, toError } from "./errors";
import { oracleFor, perRequestLayer } from "./oracle";

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
 * **只有目标形状那些**:聚合 `Database` + 参考层。那批还没挂进聚合的旧领域 Tag **不在这里**
 * —— 它们住 `oracle.ts` 的 `legacyRequestLayer`,和 `runRequest` 一起在 T13 退场。
 * 新写的 handler 拿不到它们,也就不会有人「顺手」再用一个即将消失的 Tag。
 *
 * **一次请求只有一个 `DbClient`(红线)**:聚合与参考层的四个端口都**不自己开连接**、也都不自己
 * 收 userId —— 它们的 `R` 声明 `DbClient | CurrentUser`,由 `perRequestLayer(userId)` 一次给上
 * (ADR 0044)。那一份建一次、一个引用分给两边,Effect 的 layer memoisation 保证只建一次;
 * 分两次 provide 就是两份,哪怕引用相同 —— 所以两边必须在同一个 `Layer.mergeAll` 里。
 */
export const userLayer = (userId: string): Layer.Layer<UserServices> => {
  const perRequest = perRequestLayer(userId);
  return Layer.mergeAll(Layer.provide(Database.Default, perRequest), oracleFor(perRequest));
};

/**
 * 一个用户的全部服务 —— handler 的 `R` 只能落在这个范围里。
 *
 * **参考层的端口里只透一个 `CacheStore`**(#504 T17):app 真正直接用端口的只有一处 ——
 * DeFi 协议图(`logos/store.ts`),那份数据来自用户自己同步下来的余额 meta,没有上游、不出网,
 * 不属于参考层,但要一个 per-user 的键值缓存。另外三个(`TokenStore` / `TokenPriceStore` /
 * `GlobalTokenRefIndexStore`)app 一处都没直接碰,却曾经一样露在外面 —— 那等于给任何 handler
 * 留了一条绕过参考层直接改代币行和价格行的路。
 */
export type UserServices = Database | OracleServices | CacheStore;

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
 * **发动点的内核** —— 在 `forUser` 之上补两件只有「跑」才需要的:handler 名字、日志层。
 *
 * 两个出口共用它:server fn 走 `runEffect`(下面),路由 handler 走 `runForUser`。
 * 两条路唯一的差别是**「谁认的人」** —— server fn 有 `requireAuth` 中间件把 userId 放进
 * context,路由自己调 `resolveAuth`。认完之后要做的事一模一样,所以只能有一份。
 */
const runFor = <A, E extends AppError>(
  userId: string,
  handler: string,
  effect: Effect.Effect<A, E, UserServices>,
): Promise<A> =>
  forUser(userId, effect).pipe(
    Effect.annotateLogs({ handler }),
    Effect.provide(logTapeLogger),
    Effect.runPromise,
  );

/**
 * **server fn 的发动点 —— handler 只描述,这里负责跑。**
 *
 * handler 拿到的只有 `data`,返回一个 Effect;要什么服务写在它的 `R` 通道里(`yield* Database`)。
 * 「哪个用户」「怎么装配」「错误怎么映射」「什么时候变成 Promise」全部发生在 `runFor` 那几行里,
 * handler 一个字都不必知道 —— 它连 `context` 都收不到,所以也不可能自己去读 userId 拼查询。
 *
 * 用法(装配点):`.handler(runEffect(handleCreateTabPin))`。
 *
 * 与过渡路那个 `runRequest` 的真正区别不是少打几个字,是**方向**:那个由 handler 自己调,
 * 于是每个 handler 都是「一半业务 + 一半运行时」;这个由装配点调,handler 那半干净了,
 * review 一个 handler 不再需要顺手检查它的发动、注入、错误映射写没写对。
 */
export const runEffect =
  <D, A, E extends AppError>(handler: (data: D) => Effect.Effect<A, E, UserServices>) =>
  // `context` 只声明用得着的那个字段:`requireAuth` 注入的是整个 `AuthContext`(还带 user /
  // session),而这里唯一该碰的就是 userId。少声明一个字段 = 少一条能悄悄用起来的路。
  ({ data, context }: { data: D; context: { userId: string } }): Promise<A> =>
    runFor(context.userId, handlerName(handler), handler(data));

/**
 * **路由 handler 的发动点** —— 与 server fn 同一个内核,只是人由调用方自己认。
 *
 * 那几条路由(`/api/export`、`/api/logo/*`、`/api/import`)出的是裸 `Response`,而 server fn
 * 的返回值要过序列化,所以它们不能是 server fn(理由见各自文件);但「一次请求怎么装配、
 * 失败怎么变成人话」不该因此有第二个答案。
 *
 * `name` 是这一次的身份(进日志注解)。路由这边没有 `Effect.fn` 那个函数名可白拿 ——
 * 它跑的往往是一段现拼的 effect,所以由调用方写死一个名字。
 */
export const runForUser = <A, E extends AppError>(
  name: string,
  userId: string,
  effect: Effect.Effect<A, E, UserServices>,
): Promise<A> => runFor(userId, name, effect);

/**
 * handler 在日志里的名字。**`Effect.fn("createTabPin")` 会把这个名字写进函数的 `name`**
 * (实测确认),所以这里白拿 —— 装配点不必再手写一遍,也不会跟 span 名字对不上。
 *
 * 没包 `Effect.fn` 的(过渡期还剩几个)拿到的是它的声明名 `handleXxx`,一样够用;
 * 压缩会把那种名字改掉,而 `Effect.fn` 那种是字符串常量,压不动 —— 这也是 T7 起要求
 * 每个 handler 都包 `Effect.fn` 的理由之一。
 */
const handlerName = (handler: (...args: never[]) => unknown): string => handler.name || "anonymous";
