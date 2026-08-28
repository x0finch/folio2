import { waitUntil } from "cloudflare:workers";
import { Database } from "@folio/db";
import type { OracleServices } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect, Layer } from "effect";
import { ConnectorRegistry } from "./connectors/registry";
import { logTapeLogger } from "./effect-log";
import { type AppError, toError } from "./errors";
import { oracleFor, perRequestLayer } from "./oracle";
import { spanTracer } from "./tracing";

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

/**
 * 一把钥匙上的补算状态:正在飞的那一趟、「它跑的时候又脏了」的旗子,以及连败计数。
 *
 * **模块级可变状态在 Workers 上是刻意的**(CODING.md):每个请求一次 `runPromise`,Layer 的
 * memoisation 是 per-run 的,想跨请求活着只能放模块级。作用域因此是**一个 isolate** ——
 * 两个 isolate 各跑一趟是拦不住的(与 `SyncScope.gate` 那条跨 isolate 递不过去同一回事),
 * 而要拦的那个形状(一轮同步里几十次刷新 → 几十趟全量重算)恰恰都落在同一个 isolate 上。
 */
interface Slot {
  again: boolean;
  /** 连着失败几次了。成功一次清零。 */
  failures: number;
  /** 在这一刻之前不再开工(连败退避)。 */
  quietUntil: number;
}

const slots = new Map<string, Slot>();

/** 连败几次之后彻底不再试。**必须有上限**:见 `backfillForUser` 里那台永动机。 */
const BACKFILL_MAX_FAILURES = 5;
/** 连败退避:1s、2s、4s、8s…… 15s 封顶(与 `queries/constants.ts` 的 `RETRY.delay` 同款)。 */
const backoffMs = (failures: number) => Math.min(1_000 * 2 ** failures, 15_000);

/**
 * **后台补算 —— 把一份活儿交给这次请求的 `waitUntil`,请求本体不等它**(ADR 0049 裁定 3)。
 *
 * 为什么必须是 `waitUntil` 而不是 `Effect.fork`:免费档**每次请求只给 10ms CPU**,而
 * `waitUntil` 那条路与定时任务同路、CPU 宽松(ADR 0049 有实测)。fork 出来的 fiber 还在
 * 这次请求的账上,等于把刚搬走的计算又搬回来了;何况 Worker 在响应发走之后就可能被回收,
 * 没有 `waitUntil` 登记的活儿会被半路掐死。
 *
 * **另起一次装配**,不复用调用方的 context:补算与响应那半是两个程序(同 `runSyncRound`),
 * 而 layer 的作用域跟着那次 `Effect.provide` 走 —— 借来的服务活到什么时候不该由这里赌。
 *
 * **`job` 回 `false` = 这一趟没成事。** 调度器靠它认出「这份活儿算不出来」:连败就退避、
 * 到 `BACKFILL_MAX_FAILURES` 就彻底不再试。没有这个上限的话,一份永远失败的补算配上
 * 「读到空就说 `pending`、前端见 `pending` 就每秒问一次」就是一台永动机 —— 每一次轮询排一趟
 * 全量重算,单飞把它们首尾相接地串起来,一个用户就能把这个 isolate 占满。
 *
 * **同一把钥匙同时只有一趟在跑,而且不丢事件**(单飞 + 尾随重跑):跑的时候又有人要,就把
 * 旗子插上、等这趟结束再跑**一趟**。只跳过不重跑是不行的 —— 用户连改两笔手记,第二笔的重算
 * 会被第一笔吞掉,数字就停在中间那个版本;只排队不合并也不行 —— 一轮同步里每个账户落定都会
 * 触发一次刷新,二十个账户就是二十趟全量重算,正好撞在这一片要保护的 CPU / subrequest 预算上。
 *
 * **它永不抛、永不 reject。** 三个地方都得堵上,因为它唯一的职责是「安排一件跟这次响应无关的事」,
 * 而这件事失败绝不该把只是想安排它的那个请求带走:
 *   ① `waitUntil` 在没有调用上下文时会抛(它在 `Effect.sync` 里就是个 defect);
 *   ② `runForUser` 在**装配**阶段就可能同步抛,那一段在 `job` 自己的 `catchAllCause` 外面 ——
 *      而且它抛在 `runOnce()` 里,`.catch` 根本接不到,**位子会一直占着**,此后这把钥匙上的
 *      补算全部静默消失。所以 `runOnce` 整个包在 try/catch 里,catch 负责把位子腾出来;
 *   ③ 兜不住的一律记一行 —— `waitUntil` 收下的 Promise reject 出去是条静默的 unhandled rejection。
 */
export const backfillForUser = (
  userId: string,
  key: string,
  job: Effect.Effect<boolean, never, UserServices>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const log = getLogger(["folio", "web", "backfill"]);
    const id = `${userId} ${key}`;
    const slot = slots.get(id);
    if (slot) {
      slot.again = true; // 这趟跑完再跑一趟,别把这次的变更吞了
      return;
    }
    const fresh: Slot = { again: false, failures: 0, quietUntil: 0 };
    const previous = quiet.get(id);
    if (previous) {
      if (previous.failures >= BACKFILL_MAX_FAILURES) return; // 认输了,不再试
      if (Date.now() < previous.quietUntil) return; // 还在退避里
      fresh.failures = previous.failures;
    }

    const settle = (ok: boolean): Promise<void> | undefined => {
      fresh.failures = ok ? 0 : fresh.failures + 1;
      fresh.quietUntil = ok ? 0 : Date.now() + backoffMs(fresh.failures);
      if (!ok && fresh.failures >= BACKFILL_MAX_FAILURES) {
        log.error("backfill gave up after repeated failures", { key, failures: fresh.failures });
      }
      // 退避 / 认输期间的「再跑一趟」不当场兑现 —— 兑现了就等于没有退避。
      if (!fresh.again || !ok) {
        slots.delete(id);
        quiet.set(id, fresh);
        return undefined;
      }
      fresh.again = false;
      return start();
    };
    const start = (): Promise<void> =>
      runForUser(userId, job)
        .catch((error) => {
          log.warn("backfill failed", { key, error });
          return false;
        })
        .then(settle);

    slots.set(id, fresh);
    try {
      waitUntil(start());
    } catch (error) {
      // 装配阶段同步抛 / `waitUntil` 没有调用上下文 —— **先把位子腾出来**,否则这把钥匙上的
      // 补算就永久静默了(F12:占着位子的那一趟其实从来没开始过)。
      slots.delete(id);
      log.warn("backfill could not be scheduled", { key, error });
    }
  });

// 退避 / 认输的记账与「正在飞」分开存:前者要在那一趟结束之后**继续**活着,而 `slots` 里的
// 条目一结束就得删掉(它的含义是「有一趟在飞」)。合成一张表的话,「在不在飞」与「还能不能再试」
// 会互相顶掉。
const quiet = new Map<string, Slot>();

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
  ({ data, context }: { data: D; context: { userId: string } }): Promise<A> =>
    runForUser(
      context.userId,
      handler(data).pipe(Effect.annotateLogs({ handler: handler.name || "anonymous" })),
    );
