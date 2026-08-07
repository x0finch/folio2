import { Effect, Option, Queue, Stream } from "effect";

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

export const ndjsonRound = <A>(
  results: Stream.Stream<A, { readonly message: string }>,
  opts: {
    // 一轮跑完之后的收尾(预热缓存之类)。**best-effort**:它失败不该影响这一轮的结果。
    afterRound?: () => Promise<void>;
    // 用户级失败(整轮没跑起来)时记一笔 —— 日志由调用方给,本模块不认识 logger。
    onFatal?: (message: string) => void;
  } = {},
): Promise<NdjsonRound> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Option.Option<string>>();
      const afterRound = opts.afterRound;
      const onFatal = opts.onFatal;
      const line = (value: unknown) =>
        Queue.offer(queue, Option.some(`${JSON.stringify(value)}\n`));

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
          Effect.tap(() =>
            afterRound ? Effect.promise(() => afterRound().catch(() => {})) : Effect.void,
          ),
          Effect.asVoid,
        ),
      );

      // `toReadableStream` 写成 data-first:放进 pipe 里(data-last)时它的元素类型参数无从推断,
      // 会塌成 `ReadableStream<unknown>`。
      const bytes = Stream.fromQueue(queue, { shutdown: false }).pipe(
        Stream.takeWhile(Option.isSome),
        Stream.map((some) => encoder.encode(some.value)),
      );
      return { body: Stream.toReadableStream(bytes), run };
    }),
  );
