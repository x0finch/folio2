import { Database } from "@folio/db";
import type { OraclePorts, OracleServices } from "@folio/oracle";
import { Effect, Layer } from "effect";
import { logTapeLogger } from "./effect-log";
import { type AppError, toError } from "./errors";
import { oracleFor, perRequestLayer } from "./oracle";

// **server fn 的运行时**:一次请求要的服务在这里装配,也在这里跑起来。全仓只有这一份。
//
// 它不住 `oracle.ts` —— 那个文件是**参考层的装配点**(全仓唯一同时认识 D1 store 与 CoinGecko
// adapter 的地方),跟「server fn 怎么跑起来」是两件事。

/**
 * 一次请求要的**全部服务**,作为一个 Layer。**暂不导出** —— 今天唯一的消费者是下面的
 * `runEffect`;等 sync 那条流迁过来(#504 T12)再导出,别为了「将来会用」先开口子。
 *
 * **只有目标形状那些**:聚合 `Database` + 参考层。那批还没挂进聚合的旧领域 Tag **不在这里**
 * —— 它们住 `oracle.ts` 的 `legacyRequestLayer`,和 `runStore`/`runRequest` 一起在 T13 退场。
 * 新写的 handler 拿不到它们,也就不会有人「顺手」再用一个即将消失的 Tag。
 *
 * **一次请求只有一个 `DbClient`(红线)**:聚合与参考层的四个端口都**不自己开连接**、也都不自己
 * 收 userId —— 它们的 `R` 声明 `DbClient | CurrentUser`,由 `perRequestLayer(userId)` 一次给上
 * (ADR 0044)。那一份建一次、一个引用分给两边,Effect 的 layer memoisation 保证只建一次;
 * 分两次 provide 就是两份,哪怕引用相同 —— 所以两边必须在同一个 `Layer.mergeAll` 里。
 */
const userLayer = (userId: string): Layer.Layer<UserServices> => {
  const perRequest = perRequestLayer(userId);
  return Layer.mergeAll(Layer.provide(Database.Default, perRequest), oracleFor(perRequest));
};

/** 一个用户的全部服务 —— handler 的 `R` 只能落在这个范围里。 */
export type UserServices = Database | OracleServices | OraclePorts;

/**
 * **发动点 —— handler 只描述,这里负责跑。**
 *
 * handler 拿到的只有 `data`,返回一个 Effect;要什么服务写在它的 `R` 通道里(`yield* Database`)。
 * 「哪个用户」「怎么装配」「错误怎么映射」「什么时候变成 Promise」全部发生在下面那四行之内,
 * handler 一个字都不必知道 —— 它连 `context` 都收不到,所以也不可能自己去读 userId 拼查询。
 *
 * 用法(装配点):`.handler(runEffect(handleCreateTabPin))`。
 *
 * **四步是写在这里的,不转发给谁。** `runRequest` / `runAtEdge` 长得像能省这几行,但转发一层
 * 之后「注入到底发生在哪一行」就得多跳一次才看得见 —— 而那正是这个函数唯一要说清楚的事。
 * (`runRequest` 还另有一层理由:它是给没迁的 handler 的过渡路,T13 就删,把唯一的永久入口
 * 建在它上面等于给自己排一次返工。)
 *
 * 与 `runStore` / `runRequest` 的真正区别不是少打几个字,是**方向**:那两个由 handler 自己调,
 * 于是每个 handler 都是「一半业务 + 一半运行时」;这个由装配点调,handler 那半干净了,
 * review 一个 handler 不再需要顺手检查它的发动、注入、错误映射写没写对。
 */
export const runEffect =
  <D, A, E extends AppError>(handler: (data: D) => Effect.Effect<A, E, UserServices>) =>
  // `context` 只声明用得着的那个字段:`requireAuth` 注入的是整个 `AuthContext`(还带 user /
  // session),而这里唯一该碰的就是 userId。少声明一个字段 = 少一条能悄悄用起来的路。
  ({ data, context }: { data: D; context: { userId: string } }): Promise<A> =>
    handler(data).pipe(
      Effect.provide(userLayer(context.userId)), // ← 注入发生在这一行
      Effect.mapError(toError), // ← 失败变成人话的唯一一处(见 ./errors)
      // **上下文一处挂,51 个 handler 全有。** 顺序是有讲究的:挂在 `provide` **外面**,
      // 所以连装配本身打的日志也带得上;挂在里面就只覆盖 handler 自己那段。
      Effect.annotateLogs({ userId: context.userId, handler: handlerName(handler) }),
      // span 那半今天落在 no-op tracer 上(#504 T16 才装真的),但注解写在这里不多花什么,
      // 而装上之后「这个请求是谁的」立刻就在 span 树里 —— 不必再回头改 51 个 handler。
      Effect.annotateSpans({ userId: context.userId }),
      Effect.provide(logTapeLogger),
      Effect.runPromise,
    );

/**
 * handler 在日志里的名字。**`Effect.fn("createTabPin")` 会把这个名字写进函数的 `name`**
 * (实测确认),所以这里白拿 —— 装配点不必再手写一遍,也不会跟 span 名字对不上。
 *
 * 没包 `Effect.fn` 的(过渡期还剩几个)拿到的是它的声明名 `handleXxx`,一样够用;
 * 压缩会把那种名字改掉,而 `Effect.fn` 那种是字符串常量,压不动 —— 这也是 T7 起要求
 * 每个 handler 都包 `Effect.fn` 的理由之一。
 */
const handlerName = (handler: (...args: never[]) => unknown): string => handler.name || "anonymous";
