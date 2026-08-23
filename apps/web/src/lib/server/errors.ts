import type { UpstreamError } from "@folio/client-core";
import type { InvalidInput, NotFound } from "@folio/db";

// **一次请求可能失败在哪些地方 —— 以及它们怎么变成前端看得懂的一句话。**
//
// 这里只装「有人会处理的失败」(CODING.md:`E` 里只放这种,其余走 defect)。今天是三类:
//   · `UpstreamError` 四种  —— 上游的锅(`@folio/client-core`,凭据/限流/够不到/读不动)
//   · `NotFound`            —— 不是你的东西 / 不存在(`@folio/db`,归属断言,#504 T5)
//   · `InvalidInput`        —— 你给的东西在这个上下文里不合法(`@folio/db`,#504 T6)
//
// **映射只写在这一处**(#504 T6)。以前它住 `oracle.ts` 的 `toError`,只认上游那四类;
// 现在三类都从这里过(其中两类的答案是「原样透传」,理由见 `toError` 上面那段),
// `runtime.ts` 那三个出口与过渡路的 `withRequest` 共用同一份 ——
// 「同一个失败在两条路上被说成两句话」这件事从此没有地方发生。
//
// 单测钉着它(`apps/web/tests/to-error.test.ts`):纯函数,不碰 TanStack、不碰 D1。

/** handler 的 `E` 通道允许出现的东西。`Error` 那一项是过渡路上还没类型化的那些。 */
export type AppError = UpstreamError | NotFound | InvalidInput | Error;

// **不能用 `instanceof Error` 区分上游那四类** —— `Data.TaggedError` 造出来的类自己就 extends
// Error,两边都是 true。按 `upstream` 这个字段判:四类上游错误都有它,别的没有。
// (判 `_tag` 那条约定说的是「同类之间怎么分」;这里分的是「是不是这一类」。)
const isUpstream = (error: AppError): error is UpstreamError => "upstream" in error;

/**
 * 类型化的失败 → 前端看得懂的一句话。
 *
 * **只有上游那四类需要动**,而且动的理由很具体:`Data.TaggedError` 不自带 `message`,不管的话
 * 上层日志里只剩一个空消息 + 一坨 Cause。这里现拼一句 —— 里面只有 tag、pathname 和状态码,
 * `where` 本来就刻意不带 query(原则 #5 红线),凭据、签名一个字都不进这句话。
 *
 * **`NotFound` / `InvalidInput` 原样透传,这是刻意的,别「顺手统一成 new Error」。**
 * 它们自己有 `message` getter,那句话本来就是写给人看的;而**换成新对象会把 `Effect.fn` 的
 * handler 名从 `Cause` 里抹掉** —— Effect 把 span 记在**错误对象自己**身上,新建一个就丢了,
 * 连搬 `stack` 都补不回来(三种写法都实测过)。于是兜底日志里的
 * `at createTabPin (…)` 会变成一串 effect 内部帧,`Effect.fn` 那个名字白加。
 * 下面的单测钉着这条。
 *
 * 上游那四类是**用这条换那句消息**:它们的消息里已经写明是谁、哪条路径、什么状态码,
 * 比 handler 名更能说清出了什么事。真 bug 走 defect 那条通道,`mapError` 根本碰不到它们,
 * 所以最要紧的那种情形栈是完整的。
 */
export const toError = (error: AppError): Error =>
  isUpstream(error)
    ? new Error(
        `${error.upstream} ${error._tag} on ${error.where}${
          error.status !== undefined ? ` (${error.status})` : ""
        }`,
        { cause: error },
      )
    : error;
