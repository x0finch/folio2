import { ProviderError } from "@folio/connectors-basic";
import { Data } from "effect";

// 编排层的失败类型(Effect 迁移,ADR 0035)。六种,对应 SyncDeps 的六个注入依赖 —— 一一对应而不是
// 笼统一个 `SyncError`,是为了出口也改成 Effect 之后(下一步),调用方能从类型上看到「这次同步可能
// 因为写快照失败」这种具体信息。
//
// 只有 `FetchBalancesError` 带 code / retryable / retryAfterMs —— 它是**唯一驱动重试决策**的那个;
// 其余五个一律不重试(拿不到就是拿不到,重试改变不了),带上原始错误够用。

// —— 取余额(provider 调用)——
// retryable / retryAfterMs 由下面的桥从 connectors 的 ProviderError 抄来;超时也产出本类型
//(retryable: true),这样重试策略只需要认识一种错误,不会出现「超时绕过重试」的类型对不齐。
export class FetchBalancesError extends Data.TaggedError("FetchBalancesError")<{
  readonly message: string;
  readonly code?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}> {}

// —— 其余五个依赖 ——
//
// 这五个形状一模一样(message + cause),只有 tag 不同 —— **为什么不用工厂造?**
// 试过两种(普通泛型 `<T extends string>` 与 `<const T extends string>`),都不行:
// 包一层函数之后 `_tag` 会宽化成 `string`,`Effect.catchTag("MintError", …)` 当场不认识,
// 而「按 tag 区分是哪一步挂了」正是分成六个类型的全部意义。`Data.TaggedError` 就是要直接调。
//
// 所以能省重复的唯一办法是**少定义几个类型**(比如合成一个带 `step` 字段的 SyncDepError),
// 那是另一个取舍:调用方从此只能靠字段而不是类型来分辨。当前选择是保留六个。
export class ListAccountsError extends Data.TaggedError("ListAccountsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ListRawCredsError extends Data.TaggedError("ListRawCredsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WriteSnapshotError extends Data.TaggedError("WriteSnapshotError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class MintError extends Data.TaggedError("MintError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RevalueError extends Data.TaggedError("RevalueError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ⚠️ 临时桥 —— connectors 的 `ProviderError` 还是普通 Error 子类(60 个构造点散在 9 个 provider 包、
// 11 处 instanceof、8 个测试文件),改它是独立工程,归 Effect 迁移 epic 的第 2 站(#362 的 connectors)。
// 那一步做完后 provider 直接吐 Effect 的错误类型,**本函数连同它的注释一起删掉**。
//
// 判据刻意保持迁移前的行为:`instanceof ProviderError` 而非鸭子类型(只看 `.retryable`)——
// 免得别处冒上来的、恰好带 `retryable: true` 的对象也被重试。非 ProviderError 一律不重试。
export function toFetchBalancesError(err: unknown): FetchBalancesError {
  if (err instanceof ProviderError) {
    return new FetchBalancesError({
      message: err.message,
      code: err.code,
      retryable: err.retryable,
      retryAfterMs: err.retryAfterMs,
      cause: err,
    });
  }
  return new FetchBalancesError({ message: messageOf(err), retryable: false, cause: err });
}
