import { Effect, type Layer, Option, Queue, Stream } from "effect";

// 把「逐条产出的结果流」变成「NDJSON 字节流 + 一个后台任务」。纯逻辑:不引 cloudflare:workers、
// 不碰 auth、不认识 @folio/sync —— 所以能单测(见 tests/sync-ndjson.test.ts)。
//
// 这里就是 /api/sync 的核心那一手:**把「跑」和「看」拆开**。
//   · 跑 —— `run` 是一个已经在跑的 Promise,调用方交给 `waitUntil`,与连接无关
//   · 看 —— `body` 只是观察窗,前端断开只是没人读了,跑的那头照常跑完
// 两者之间用一个**无界** Effect Queue 接力:同步那头 offer,响应流那头 take。无界是关键 ——
// 前端读得慢(或根本不读)都不该把生产端卡住。一轮最多账户数条,量很小。
//
// **结束用哨兵,不用 `Queue.shutdown`。** shutdown 会把队列里还没被取走的项直接丢掉,于是最后
// 一行会和它抢:用户级失败那条 `{ fatal }` 是在前面的结果被取走之后才 offer 的,紧跟着就 shutdown,
// 它就丢了 —— 前端只看到流静默结束,`readSyncStream` 正常返回 done:0,UI 显示「同步了 0 个账户」
// 而不是报错。哨兵走的是同一条 FIFO,排在它前面的每一行都保证送达。tests 有一条钉这个。

const encoder = new TextEncoder();

// 队列里的结束标记:`Option.none()`。走同一条队列而不是另开一个信号通道 —— 它和数据同序,
// 这正是要的性质。用 Option 是因为 `Option.isSome` 是个真正的类型守卫,`takeWhile` 之后
// 元素类型就收窄成 string,不用往下强转。
const END = Option.none<string>();

export interface NdjsonRound {
  body: ReadableStream<Uint8Array>;
  run: Promise<void>;
}

// **出口是 Effect,不是 Promise**(#394 T5):建队列这件事本来就是个 effect,而调用方(路由 handler)
// 现在有自己的边缘 —— 它把鉴权之后的整段拼成一个 effect 再跑一次。以前这里自己 `runPromise`,
// 于是同一个请求里多切一道边界,只为把一个同步就能建好的队列取出来。
//
// **`run` 仍是 Promise,而且仍由本模块 `runPromise`。** 它不是「中途转了一次」——
// `waitUntil` 收的就是 Promise,而这个后台任务与响应那半**是两个程序**:响应流结束之后它照跑。
// 一个程序一个边缘,这里恰好有两个。
export const ndjsonRound = <A, R>(
  results: Stream.Stream<A, { readonly message: string }, R>,
  opts: {
    // 流与收尾**共用的那一次装配**(#504 T12)。收 layer 而不是收两个装好的东西,是这条路
    // 「一个请求一个 `DbClient`」的实现方式:下面只 provide 一次,memoisation 的作用域就是那一次。
    // 以前流那半自己 `Stream.provideLayer` 装一次,收尾那半在自己的 `runAtEdge` 里再装一次 ——
    // 同一个请求两个 drizzle 句柄,今天只是浪费,而 `DbClient` 一旦长出状态就是悄悄劈成两半。
    layer: Layer.Layer<R>;
    // 一轮跑完之后的收尾(预热缓存之类)。**best-effort**:它失败不该影响这一轮的结果。
    afterRound?: Effect.Effect<unknown, unknown, R>;
    // 用户级失败(整轮没跑起来)时记一笔 —— 日志由调用方给,本模块不认识 logger。
    onFatal?: (message: string) => void;
  },
): Effect.Effect<NdjsonRound> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Option.Option<string>>();
    const afterRound = opts.afterRound;
    const onFatal = opts.onFatal;
    const line = (value: unknown) => Queue.offer(queue, Option.some(`${JSON.stringify(value)}\n`));

    // 不 await —— 调用方拿到这个 Promise 交给 waitUntil。
    const run = Effect.runPromise(
      results.pipe(
        Stream.runForEach(line),
        // 用户级失败也要让前端看见,别让流静默地空着结束。
        Effect.catchAll((e) =>
          line({ fatal: e.message }).pipe(
            Effect.tap(() => Effect.sync(() => onFatal?.(e.message))),
          ),
        ),
        // 收尾:排一个哨兵进队列 → 响应流读到它就自然结束。
        //
        // **哨兵排在 afterRound 之前**,这个顺序是有代价换来的:反过来的话,「看」的那一半要等
        // 一件与它无关的事 —— 预热缓存 —— 做完才收工。e2e 里量到过:两个账户的结果早就全部
        // 送达(toast 停在「Syncing 2/2」),而成功 toast 迟迟不出,因为 warmTokensForUser 在打
        // 一圈拿不到的上游。结果都出去了就该让前端收工;剩下的收尾归 waitUntil,与连接无关。
        Effect.ensuring(Queue.offer(queue, END)),
        // **兜的是 `Exit` 不是类型化失败**:收尾是尽力而为,它自己的 bug(defect)也不该
        // 把这一轮变成异常收尾。改造前那句 `afterRound().catch(() => {})` 兜的正是两类
        //(`runPromise` 对 defect 也是 reject),这里保持同一个宽度。
        Effect.tap(() => (afterRound ? Effect.asVoid(Effect.exit(afterRound)) : Effect.void)),
        Effect.asVoid,
        // **一次 provide,流与收尾共用。** 放在最外面 —— 放进去任何一半,另一半就得自己再装一次。
        Effect.provide(opts.layer),
      ),
    );

    // `toReadableStream` 写成 data-first:放进 pipe 里(data-last)时它的元素类型参数无从推断,
    // 会塌成 `ReadableStream<unknown>`。
    const bytes = Stream.fromQueue(queue, { shutdown: false }).pipe(
      Stream.takeWhile(Option.isSome),
      Stream.map((some) => encoder.encode(some.value)),
    );
    return { body: Stream.toReadableStream(bytes), run };
  });
