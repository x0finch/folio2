import { Effect } from "effect";
import type { Balance } from "./balance";
import type { BalanceProvider, FetchContext } from "./connector";
import { fromProviderError } from "./connector-error";
import type { CredField, CredsOf } from "./creds";
import type { Note } from "./note";

// ⚠️ **临时垫片** —— 契约(`BalanceProvider`)的出口已经是 `Effect`,而 9 个 provider 的实现内部
// 还是 Promise + 老的 `ProviderError`。本片刻意**不动实现内部**(那是 B2 各片接线时的事,连同
// 请求层一起搬),所以这里给它们一层包装:方法体一个字不改,`Effect.tryPromise` 在外面接住,
// 错误经 `fromProviderError` 转成 `ConnectorError`。
//
// **为什么是包在整个 provider 外面,而不是每个方法自己包一层**:后者要把方法体从对象字面量里搬出来
// (缩进全动、`ctx` 的类型推断也丢了),diff 里看不出「哪些是真改动」。包在外面的话每个 provider
// 只动首尾两行,而且**「这个 provider 还没转成原生 Effect」一眼可见** —— B2 转完一个就摘掉一个,
// 摘干净了这个文件连同 `fromProviderError` 一起删。
export interface PromiseBalanceProvider<
  B extends Balance,
  AC extends readonly CredField[] = readonly CredField[],
  PC extends readonly CredField[] = readonly CredField[],
> extends Omit<BalanceProvider<B, AC, PC>, "fetchBalances" | "validateAccount"> {
  fetchBalances(
    ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>,
  ): Promise<{ balances: B[]; note?: Note[] }>;
  validateAccount(ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>): Promise<boolean>;
}

export function promiseProvider<
  B extends Balance,
  AC extends readonly CredField[] = readonly CredField[],
  PC extends readonly CredField[] = readonly CredField[],
>(provider: PromiseBalanceProvider<B, AC, PC>): BalanceProvider<B, AC, PC> {
  return {
    ...provider,
    fetchBalances: (ctx) =>
      Effect.tryPromise({ try: () => provider.fetchBalances(ctx), catch: fromProviderError }),
    validateAccount: (ctx) =>
      Effect.tryPromise({ try: () => provider.validateAccount(ctx), catch: fromProviderError }),
  };
}
