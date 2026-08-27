import { Cause, Effect, Exit, type Layer, Stream } from "effect";

// 一轮同步在后台跑到底 —— **ADR 0048 之后这条路上只剩「跑」,没有「看」了**。
//
// 以前 `/api/sync` 回的是一条 NDJSON 观察流:同步那头往一个无界队列里 offer,响应流那头 take,
// 前端边收边推进它自己那份进度。那套东西整体退役,因为进度不再住在浏览器里 —— 它是服务端事实,
// 每个账户跑完就写进那一轮的记录,前端轮询去读。于是队列、哨兵、分片解析、以及「断开只是不看了」
// 那一整套解释,统统不必存在:请求早就返回了,这条任务本来就与任何连接无关。
//
// 留在这一层的只有编排顺序,而它有四条讲究:
//   · **逐条落**(`onResult`)—— 不攒到最后一次性写,否则进度条会在最后一刻从 0 跳到满。
//   · **账本不撕轮**:settle 走 DbClient,错误通道 never,它真出错是 defect —— 一笔账没记上
//     不该让剩余账户不跑、收官不写。每条 onResult 各自兜住,记一行 warning 继续。
//   · **一定收官**(`onDone`),而且是 **Exit 级**的保证 —— 成功、类型化失败、defect 三种下场
//     都走一遍。不收官那一轮会一直显示「在跑」,直到 120s 后被判成中断,而它其实早就死透了。
//     收官自己炸了也兜住:这条 Promise 交给 waitUntil,reject 出去就是一条静默的 unhandled
//     rejection,所以**它永不 reject**。
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
): Promise<void> => {
  // 用户级失败(取账户 / 取凭据挂了)带 message;defect 只能念 Cause —— 两种都得说成人话,
  // 因为它就是面板上「整轮没跑起来」那一句。
  const messageOf = (cause: Cause.Cause<{ readonly message: string }>): string => {
    const failure = Cause.failureOption(cause);
    return failure._tag === "Some" ? failure.value.message : Cause.pretty(cause);
  };
  return Effect.runPromise(
    results.pipe(
      Stream.runForEach((result) =>
        // 账本不撕轮:一笔 settle 落不上(defect —— DbClient 的错误通道是 never),记一行接着跑。
        opts
          .onResult(result)
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.logWarning("sync round settle failed", Cause.pretty(cause)),
            ),
          ),
      ),
      // **Exit 级收官**:matchEffect 只接类型化失败,defect 会从它旁边穿过去 —— 那正是
      // 「一次 D1 瞬时错让整点后面所有用户都不同步」那条事故链的第一环。
      Effect.exit,
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) return opts.onDone(null);
        const message = messageOf(exit.cause);
        return Effect.sync(() => opts.onFatal?.(message)).pipe(
          Effect.zipRight(opts.onDone(message)),
        );
      }),
      // 收官自己也可能炸(finish 也走 DbClient)—— 记一行,别让它变成 waitUntil 里的
      // unhandled rejection。到这一步真没有更多可做的了:轮会在心跳过期后如实显示成中断。
      Effect.catchAllCause((cause) =>
        Effect.logError("sync round finish failed", Cause.pretty(cause)),
      ),
      // **兜的是 `Exit` 不是类型化失败**:收尾是尽力而为,它自己的 bug(defect)也不该把这一轮
      // 变成异常收尾。
      Effect.zipRight(opts.afterRound ? Effect.asVoid(Effect.exit(opts.afterRound)) : Effect.void),
      // **一次 provide,流、落库与收尾共用。** 放在最外面 —— 放进去任何一半,另一半就得自己再装一次。
      Effect.provide(opts.layer),
    ),
  );
};
