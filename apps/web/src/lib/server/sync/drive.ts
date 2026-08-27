import { Effect, type Layer, Stream } from "effect";

// 一轮同步在后台跑到底 —— **ADR 0048 之后这条路上只剩「跑」,没有「看」了**。
//
// 以前 `/api/sync` 回的是一条 NDJSON 观察流:同步那头往一个无界队列里 offer,响应流那头 take,
// 前端边收边推进它自己那份进度。那套东西整体退役,因为进度不再住在浏览器里 —— 它是服务端事实,
// 每个账户跑完就写进那一轮的记录,前端轮询去读。于是队列、哨兵、分片解析、以及「断开只是不看了」
// 那一整套解释,统统不必存在:请求早就返回了,这条任务本来就与任何连接无关。
//
// 留在这一层的只有编排顺序,而它有三条讲究:
//   · **逐条落**(`onResult`)—— 不攒到最后一次性写,否则进度条会在最后一刻从 0 跳到满。
//   · **一定收官**(`onDone`)—— 成功走一遍,整轮没跑起来也走一遍。不收官那一轮会一直显示
//     「在跑」,直到 120s 后被判成中断,而它其实早就死透了,那 120s 是白等的。
//   · **收官排在收尾之前** —— 反过来的话,面板要等一件与它无关的事(预热缓存,可能在打一圈
//     拿不到的上游)做完,才看得到「这一轮结束了」。e2e 里量到过这个延迟。
//
// 本模块不引 cloudflare:workers、不认识 @folio/db、不认识 @folio/sync —— 所以它测得动
//(见 tests/sync-drive.test.ts),而生产的接线在 ./round。

export interface DriveRoundOptions<A, R> {
  /**
   * 流与收尾**共用的那一次装配**。收 layer 而不是收两个装好的东西,是这条路「一个请求一个
   * `DbClient`」的实现方式:下面只 provide 一次,memoisation 的作用域就是那一次。
   *
   * **这张 layer 必须自带 logger。** 下面那句 `runPromise` 另起一条**根 fiber**,而根 fiber
   * 不继承外层的 `Effect.provide` —— 外面装的 logTapeLogger 对它无效。
   */
  layer: Layer.Layer<R>;
  /** 一个账户有结果了。 */
  onResult: (result: A) => Effect.Effect<void, never, R>;
  /** 这一轮结束了。`error` 非空 = 整轮没跑起来(逐账户的失败不走这里)。 */
  onDone: (error: string | null) => Effect.Effect<void, never, R>;
  /** 收官之后的收尾(预热缓存之类)。**best-effort**:它失败不该影响这一轮的结果。 */
  afterRound?: Effect.Effect<unknown, unknown, R>;
  /** 整轮没跑起来时记一笔 —— 日志由调用方给,本模块不认识 logger。 */
  onFatal?: (message: string) => void;
}

/**
 * 出口是 Promise,因为收它的是 `waitUntil` —— 这条任务与响应那半**是两个程序**:
 * 请求早就回去了,它还在跑。一个程序一个边缘,这里恰好有两个。
 */
export const driveRound = <A, R>(
  results: Stream.Stream<A, { readonly message: string }, R>,
  opts: DriveRoundOptions<A, R>,
): Promise<void> =>
  Effect.runPromise(
    results.pipe(
      Stream.runForEach(opts.onResult),
      Effect.matchEffect({
        onFailure: (e) =>
          Effect.sync(() => opts.onFatal?.(e.message)).pipe(
            Effect.zipRight(opts.onDone(e.message)),
          ),
        onSuccess: () => opts.onDone(null),
      }),
      // **兜的是 `Exit` 不是类型化失败**:收尾是尽力而为,它自己的 bug(defect)也不该把这一轮
      // 变成异常收尾 —— 那会变成 `waitUntil` 里一条静默的 unhandled rejection。
      Effect.zipRight(opts.afterRound ? Effect.asVoid(Effect.exit(opts.afterRound)) : Effect.void),
      // **一次 provide,流、落库与收尾共用。** 放在最外面 —— 放进去任何一半,另一半就得自己再装一次。
      Effect.provide(opts.layer),
    ),
  );
