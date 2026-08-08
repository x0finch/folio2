import type { Effect, Option } from "effect";

// **参考层的端口是 Effect 形状(#362 第 4 站),而 db 这一站还没迁**(第 5 站;而且判据写在
// epic 里:收益小的包可以永远不迁)。Promise ↔ Effect 的缝必须落在某处,落在装配点
// (`apps/web/.../internal/oracle.ts`:全仓唯一同时认识 D1 与上游的文件)。
//
// 于是 db 这一侧需要「同一个契约的 Promise 说法」。**它是推导出来的,不是抄的** ——
// 抄一份就有两份会各自长歪的接口,而这里 `@folio/oracle-basic` 一改方法签名,db 当场编译红。
//
// 只 `import type`:db 因此不在运行时依赖 `effect`。
//
// `Plain` 把 `Option` 摘掉:Option 是 Effect 那一侧的词汇,db 照旧回 `undefined` / `null`,
// 由装配点那一层 `Option.fromNullable` 收口(两种空值都吃)。
type Plain<A> = A extends Option.Option<infer T> ? T | undefined | null : A;

export type AsPromise<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer S, infer _E, infer _R>
    ? (...args: A) => Promise<Plain<S>>
    : T[K];
};
