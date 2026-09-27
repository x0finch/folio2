import { Context, Effect } from "effect";

// **「这次请求是谁的」** —— per-user 的 op 从这里拿 userId(ADR 0044),**在每次调用时读**(ADR 0054)。
//
// ADR 0037 那条保证一个字没变:方法签名里一个 user 参数都没有,拿错用户在编译期就发生不了。
// 变的是**读的时机**:以前每个领域在建自己那一刻读一次、绑进闭包 —— 于是整张服务图只能每请求建
// 一遍(生产 profile 里那一下是 5–7ms CPU,免费计划一次请求只有 10ms)。现在服务图每个 isolate
// 建一次,userId 在 op 真跑的那一刻从 fiber 的 context 里取(`database.ts` 的 `bindPerCall`,
// 全包唯一一处)。代价是它进了每个 op 的 `R` —— 那正是要的:没给 user 的 effect 跑不起来。
//
// **故意不给默认值**(所以是 `Context.Tag` 而不是 `Context.Reference`):`Reference` 强制要
// `defaultValue`,忘了 provide 不会报错,会静默按默认用户去查 —— 跨用户数据这种地方,忘了就该
// 编译不过。
//
// **这个 Tag 不出包,只出类型**(`index.ts` 里是 `export type`)。它一出包,包外任何一处都能
// `Layer.succeed(CurrentUser, 随便谁)` —— 「对不同用户各跑一遍」那件事的全部材料就是这个值。
// 包外能拿到的只有下面这一个组合子,而它在 app 里只许出现在装配点(`apps/web` 的
// `user-services-surface.test.ts` 按源码钉着)。
export class CurrentUser extends Context.Tag("db/CurrentUser")<CurrentUser, string>() {}

/**
 * 「这段 effect 是这个用户的」—— **包外给 user 的唯一方式**。
 *
 * 形状是组合子而不是 layer:一次请求要给的就是一个字符串,不值得为它建一次 layer
 * (layer 要一张 memo 表 + 一个 scope,那正是这次要从每请求的账上拿掉的东西)。
 */
export const provideCurrentUser =
  (userId: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentUser>> =>
    Effect.provideService(self, CurrentUser, userId);
