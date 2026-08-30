import { Cause, Effect, Exit, Layer, Option } from "effect";
import { computeHomeTabStrip, overviewFromSnapshotData } from "@/lib/core/portfolio";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import type { AppError } from "@/lib/server/errors";
import type { PortfolioScope } from "@/lib/server/portfolio/scope";
import { handleGetPortfolioSnapshotData } from "@/lib/server/portfolio/snapshot-data";
import { runForUser, type UserServices } from "@/lib/server/runtime";
import { handleGetPortfolioTabPins } from "@/lib/server/tab-pins/read";
import { handleListTags } from "@/lib/server/tags/list";

// **被测的是 handler,发动走生产那个内核。**
//
// `runForUser` 就是 server fn 装配点用的那一个(`runEffect` 在它外面只多套一层 `toError`),
// 所以这里跑的接线与线上逐字相同:同一份 per-user layer、同一个 D1 句柄、同一套参考层。
// 我们不自己拼 layer —— 那会造出第二条只有测试走的路,而它一旦跟生产走散,绿的测试就没有意义了。

/** 跑一个 handler,期望它成功。失败会抛(Cause 由 `runForUser` 的兜底日志打出来)。 */
export const call = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runForUser(userId, effect);

/**
 * 跑一个 handler,把成败原样拿回来。
 *
 * **失败面的用例必须用这个,不能用 `expect(...).rejects`** —— 后者只能看到 `FiberFailure`
 * 的字符串,断言不到「失败的是 NotFound 还是 InvalidInput」。而这套清单里大量用例的要点
 * 恰恰是「拒得对不对」,不是「拒了没有」。
 */
export const callExit = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<Exit.Exit<A, E>> => runForUser(userId, Effect.exit(effect)) as Promise<Exit.Exit<A, E>>;

/**
 * 换掉 connector 门票再跑。
 *
 * 为什么可以这样换:`runForUser` 是在 effect **外面** provide,而这里先在里面 provide 了同一个
 * Tag —— 内层赢。于是「探活失败会怎样」这类用例不必真的去打上游,也不必改生产代码留测试钩子。
 */
export const callWithRegistry = <A, E extends AppError, R extends UserServices>(
  userId: string,
  registry: ConnectorRegistry,
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  runForUser(userId, Effect.provide(effect, Layer.succeed(ConnectorRegistry, registry)));

export const callWithRegistryExit = <A, E extends AppError, R extends UserServices>(
  userId: string,
  registry: ConnectorRegistry,
  effect: Effect.Effect<A, E, R>,
): Promise<Exit.Exit<A, E>> =>
  runForUser(
    userId,
    Effect.exit(Effect.provide(effect, Layer.succeed(ConnectorRegistry, registry))),
  ) as Promise<Exit.Exit<A, E>>;

/**
 * 从 Exit 里取出那个**类型化错误**。
 *
 * 失败面的用例几乎都要它:「拒了」不够,要断言「拒的方式对不对」—— `NotFound` 是资源不存在或
 * 越权,`InvalidInput` 是调用方拼错了参数、该收到一句人话。`undefined` 表示这次不是类型化失败
 * (成功,或者是 defect —— 后者用 `Cause.isDie` 单独断言)。
 */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

// —— 读模型捷径(照抄前端 select,不复刻业务逻辑)——

/**
 * 读总览 —— 改完数据之后想看「屏幕上是什么」就用它。
 *
 * **走的是首页那条真链路**(FOL-48):接口发快照原料,`overviewFromSnapshotData` 在客户端算成
 * 总览。照抄前端 `select` 那一行(不复刻业务逻辑),所以总额 / 持仓 / 小计 / pricesStale
 * 与屏幕上完全同源。总览不再读预计算,故不必先 `precompute`。
 */
export const readOverview = async (userId: string, data: PortfolioScope = {}) =>
  overviewFromSnapshotData(await call(userId, handleGetPortfolioSnapshotData(data)));

/** 同上,tab 条那条 —— 快照原料 + tabPins + 标签,浏览器现算(FOL-49)。 */
export const readTabStrip = async (userId: string, data: { portfolioId?: string } = {}) => {
  const [snapshot, tabPins, tags] = await Promise.all([
    call(userId, handleGetPortfolioSnapshotData({ portfolioId: data.portfolioId })),
    call(userId, handleGetPortfolioTabPins()),
    call(userId, handleListTags({ portfolioId: data.portfolioId })),
  ]);
  return computeHomeTabStrip(snapshot, tabPins, tags);
};
