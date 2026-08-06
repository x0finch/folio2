import type { SigningFailure } from "@folio/client-core";
import { Context, Effect, Option } from "effect";

export type SignRequest = (
  method: string,
  path: string,
  params: Record<string, unknown>,
) => Effect.Effect<Record<string, string>, SigningFailure>;

// 签名器。**可选服务** —— `Effect.serviceOption` 读它,所以 **`R` 通道不受污染**,
// 与 `Fetcher` / `SlotCacheOverride` 同一套。
//
// 为什么是服务而不是直接调:`./sign` 顶层 `import … from "../vendor/rabby_sign.wasm"`,
// 而 `.wasm` 只在 Workers 运行时 / 构建链里解析得动 —— **普通 node 环境一 import 就炸**。
// 老代码为此把它做成「按需 `await import`」,代价是签名那段在 node 测试里根本跑不到,
// 于是「签的是哪一串、头对不对」全靠 Workers pool 里的集成测试。
// 做成可选服务之后:生产不 provide,走下面那个动态 import;测试 provide 一个假的,
// 签名的**接线**(params 是不是发出去那份、头有没有带全)就能在普通测试里钉住。
export class RabbySigner extends Context.Tag("clients/RabbySigner")<RabbySigner, SignRequest>() {}

// 没 provide 时:按需加载真家伙。
//
// **动态 import,绝不提到顶层** —— 除了上面那条 `.wasm` 的硬理由,顺带让 wasm 实例化不进
// Worker 的启动路径(启动 CPU 预算)。模块系统自己会缓存,不需要我们再存一个函数引用。
const realSigner: SignRequest = (method, path, params) =>
  Effect.flatMap(
    Effect.promise(() => import("./sign")),
    (mod) => mod.signRabbyRequest(method, path, params),
  );

export const currentSigner: Effect.Effect<SignRequest> = Effect.map(
  Effect.serviceOption(RabbySigner),
  (override) => (Option.isSome(override) ? override.value : realSigner),
);
