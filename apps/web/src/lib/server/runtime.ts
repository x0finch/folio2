import type { UpstreamError } from "@folio/client-core";
import { Effect } from "effect";
import { type RequestServices, requestLayer, runAtEdge, toError } from "./oracle";

// **server fn 的运行时**:一次请求怎么从「一段描述」变成「一个 Promise」。全仓只有这一份。
//
// 它不住 `oracle.ts` —— 那个文件是**参考层的装配点**(全仓唯一同时认识 D1 store 与 CoinGecko
// adapter 的地方),跟「server fn 怎么跑起来」是两件事。混在一起的话,以后想读懂发动这条路,
// 得先翻过三个上游 adapter 的接线。

/**
 * **发动点 —— handler 只描述,这里负责跑。**
 *
 * handler 拿到的只有 `data`,返回一个 Effect;要什么服务写在它的 `R` 通道里(`yield* Database`)。
 * 「哪个用户」「怎么装配」「错误怎么映射」「什么时候变成 Promise」全部发生在下面那四行之内,
 * handler 一个字都不必知道 —— 它连 `context` 都收不到,所以也不可能自己去读 userId 拼查询。
 *
 * 用法(装配点):`.handler(runEffect(handleCreateTabPin))`。
 *
 * **三步是写在这里的,不是转发给别人的。** `runRequest` / `runStore` 长得像能省这几行,但那两个
 * 是**给还没迁的 handler 用的过渡路**,迁完就删(#504 T13);把唯一的发动点建在一个即将消失的
 * 东西上,等于给自己排了一次返工。而且转发一层之后,「注入到底发生在哪一行」就得多跳一次才看得见
 * —— 那正是这个文件唯一要说清楚的事。
 *
 * 与 `runStore` / `runRequest` 的真正区别不是少打几个字,是**方向**:那两个由 handler 自己调,
 * 于是每个 handler 都是「一半业务 + 一半运行时」;这个由装配点调,handler 那半干净了,
 * review 一个 handler 不再需要顺手检查它的发动、注入、错误映射写没写对。
 */
export const runEffect =
  <D, A, E extends UpstreamError | Error>(
    handler: (data: D) => Effect.Effect<A, E, RequestServices>,
  ) =>
  // `context` 只声明用得着的那个字段:`requireAuth` 注入的是整个 `AuthContext`(还带 user /
  // session),而这里唯一该碰的就是 userId。少声明一个字段 = 少一条能悄悄用起来的路。
  ({ data, context }: { data: D; context: { userId: string } }): Promise<A> =>
    handler(data).pipe(
      Effect.provide(requestLayer(context.userId)), // ← 注入发生在这一行
      Effect.mapError(toError),
      runAtEdge,
    );
