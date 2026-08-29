import { Cause, Effect, Exit, Layer, Option } from "effect";
import { overviewFromSnapshotData } from "@/lib/core/portfolio";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import type { AppError } from "@/lib/server/errors";
import { precomputePortfolio } from "@/lib/server/portfolio/precompute";
import type { PortfolioScope } from "@/lib/server/portfolio/scope";
import { handleGetPortfolioSnapshotData } from "@/lib/server/portfolio/snapshot-data";
import { handleGetHomeTabStrip } from "@/lib/server/portfolio/tabs";
import { runForUser, type UserServices } from "@/lib/server/runtime";
import { db } from "./db";

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

// —— 预计算过的读取(ADR 0049)——
//
// 总览与 tab 条这两条读接口只做「读 + 传」:数字是同步收官那一刻算好的。所以任何要断言
// **数字**的用例都得先让预计算跑一遍,否则读到的是空态 —— 而那正是「缺预计算」那一组
// 单独在测的东西。生产上这两步一个在同步收官、一个在请求里,测试里按同样的顺序自己走一遍。
//
// **住在这儿而不是各文件各写一份**:十来个用例文件用它,抄十遍的东西每份都会慢慢长歪。

/** 跑一遍预计算(= 同步收官时那一步)。缺省组合 = 默认组合。 */
export const precompute = async (userId: string, portfolioId?: string): Promise<string> => {
  const pf = portfolioId ?? (await db(userId).portfolios.ensureDefault()).id;
  // `precomputePortfolio` 把失败咽下去回 `false`(它挂在同步收尾上,不该让那一轮异常收尾)。
  // 测试里那等于「读到的全是空态」,而空态会把断言的失败指向一个错误的地方 —— 所以在这儿炸,
  // 真正的原因由它记的那行 warning 带着 Cause 打出来。
  if (!(await call(userId, precomputePortfolio(pf)))) {
    throw new Error(`precompute failed for ${pf} — 见上面那行 "precompute failed" warning`);
  }
  return pf;
};

/**
 * 读总览 —— 改完数据之后想看「屏幕上是什么」就用它。
 *
 * **走的是首页那条真链路**(FOL-48):接口发快照原料,`overviewFromSnapshotData` 在客户端算成
 * 总览。照抄前端 `select` 那一行(不复刻业务逻辑),所以总额 / 持仓 / 小计 / pricesStale
 * 与屏幕上完全同源。总览不再读预计算,故不必先 `precompute`。
 */
export const readOverview = async (userId: string, data: PortfolioScope = {}) =>
  overviewFromSnapshotData(await call(userId, handleGetPortfolioSnapshotData(data)));

/** 同上,tab 条那条。 */
export const readTabStrip = async (userId: string, data: { portfolioId?: string } = {}) => {
  await precompute(userId, data.portfolioId);
  return call(userId, handleGetHomeTabStrip(userId, data));
};

/**
 * 轮询到条件成立(或用完次数)。**不断言墙上时钟** —— 后台补算跑在 `waitUntil` 上,测试
 * 拿不到那条 Promise,而「等固定毫秒再断言」正是 CODING.md 点名的 flaky 写法。
 */
export const until = async <A>(
  read: () => Promise<A>,
  ok: (a: A) => boolean,
  tries = 100,
): Promise<A> => {
  let last = await read();
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 20));
    last = await read();
  }
  return last;
};
