import { Context, Effect, Option } from "effect";

// 出网这一下用哪个 `fetch`。**可选服务** —— `Effect.serviceOption` 读它,所以 **`R` 通道不受污染**
// (不 provide 也能跑),与 `SlotCacheOverride` 同一套写法。
//
// 为什么不是 `HttpConfig` 上的一个字段:那是「构造器注入」,是迁移前 `createHttpClient` 的形状。
// 后果是同一个包里「测试怎么替掉出网」有两个答案 —— 缓存走服务、fetch 走参数;而且一旦替换点要
// 分层(比如某个 Layer 想给所有 client 换一份带埋点的 fetch),参数那条路要求每个调用点都改。
//
// 生产不 provide,回退到全局 fetch。**回退时必须 `bind`**:在 CF Workers 上把 fetch 存进变量
// 再调会丢 this,出网静默失败(见 memory / DEPLOY.md)。这条有测试钉住。
export class Fetcher extends Context.Tag("client-core/Fetcher")<
  Fetcher,
  typeof globalThis.fetch
>() {}

export const currentFetch: Effect.Effect<typeof globalThis.fetch> = Effect.map(
  Effect.serviceOption(Fetcher),
  (override) => (Option.isSome(override) ? override.value : globalThis.fetch.bind(globalThis)),
);
