import { Data } from "effect";

// 编排层的失败类型(Effect 迁移,ADR 0035)。六种,对应 SyncDeps 的六个注入依赖 —— 一一对应而不是
// 笼统一个 `SyncError`,是为了出口也改成 Effect 之后(下一步),调用方能从类型上看到「这次同步可能
// 因为写快照失败」这种具体信息。
//
// **取余额的失败不在这个文件里** —— 它是 `@folio/connectors-basic` 的 `ConnectorError`(四类 tagged
// error),provider 直接吐,本包原样接住。以前这里有一个 `FetchBalancesError` 和一座从 `ProviderError`
// 抄字段的桥,那是 provider 契约还是 Promise 时的过渡物;契约改成 Effect 之后两者一起删了 ——
// **少一次翻译,就少一处「翻译时把 retryable 抄丢了」的可能**。

// —— 其余五个依赖:合成一个,用 step 区分 ——
//
// 为什么取余额的失败单独一套(`ConnectorError`)、这五个合成一个:**只有取余额的失败会驱动决策**
//(重不重试、等多久),所以它值得按「调用方要区分什么」分成四类。
// 其余五步的失败处理完全一样 —— 记一笔,然后要么降级要么算这个账户失败;调用方不需要
// 在类型层面分辨它们,一个 step 字段够了。
//
// (顺带记一笔:这五个本来是五个独立 TaggedError。想用工厂消除重复行不通 —— 包一层函数
// 之后 `_tag` 会宽化成 string,`Effect.catchTag` 当场失效。要么抄五遍,要么就是现在这样。)
export type SyncDepStep = "listAccounts" | "listRawCreds" | "writeSnapshot" | "mint" | "revalue";

export class SyncDepError extends Data.TaggedError("SyncDepError")<{
  readonly step: SyncDepStep;
  readonly message: string;
  readonly cause?: unknown;
}> {}

// 从任意抛出物造一个 —— 五个调用点形状一样,收口在这。
export function depError(step: SyncDepStep, cause: unknown): SyncDepError {
  return new SyncDepError({ step, message: messageOf(cause), cause });
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
