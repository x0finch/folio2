import type { Balance } from "@folio/connectors-basic";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Context, Effect, Layer } from "effect";
import {
  depError,
  type FetchBalancesError,
  type SyncDepError,
  toFetchBalancesError,
} from "./errors";
import type { FetchOutcome, SyncDeps, SyncLogger } from "./types";

// 编排要用的**能力**,一个一个具名。业务代码从上下文取能力,不再一层层透传 deps / account /
// stored 这些「材料」—— 谁需要什么,签名上看得见。
//
// 每个能力的错误类型也写在这:只有取余额会驱动决策(重不重试、等多久),所以它单独一个错误类型;
// 其余都是 SyncDepError。

export class Accounts extends Context.Tag("sync/Accounts")<
  Accounts,
  {
    readonly list: (userId: string) => Effect.Effect<readonly AccountSafe[], SyncDepError>;
    readonly rawCreds: (userId: string) => Effect.Effect<readonly AccountRawCreds[], SyncDepError>;
  }
>() {}

export class Balances extends Context.Tag("sync/Balances")<
  Balances,
  {
    readonly fetch: (
      account: AccountSafe,
      stored: Record<string, string>,
    ) => Effect.Effect<FetchOutcome, FetchBalancesError>;
  }
>() {}

export class Snapshots extends Context.Tag("sync/Snapshots")<
  Snapshots,
  {
    readonly write: (
      userId: string,
      accountId: string,
      input: WriteSnapshotInput,
    ) => Effect.Effect<string, SyncDepError>;
  }
>() {}

// 认币与重估合成一个能力:它们都是「参考层帮我把这批余额认清楚 / 定好价」,
// 而且顺序上绑死(mint 先、revalue 拿它的答案)。
export class Tokens extends Context.Tag("sync/Tokens")<
  Tokens,
  {
    readonly mint: (
      userId: string,
      balances: Balance[],
    ) => Effect.Effect<ReadonlyMap<string, string>, SyncDepError>;
    // null = 没重估。调用方据此决定要不要重算 totalUsd —— 只有真重估过才重算,
    // 否则保留 provider 报的那个数(它未必等于各行之和)。
    readonly revalue: (
      userId: string,
      connectorId: string,
      balances: Balance[],
      idByRef: ReadonlyMap<string, string>,
    ) => Effect.Effect<Balance[] | null, SyncDepError>;
  }
>() {}

export class SyncLog extends Context.Tag("sync/Log")<SyncLog, SyncLogger>() {}

export type SyncServices = Accounts | Balances | Snapshots | Tokens | SyncLog;

// 没注入 mint 时的空答案。共享一个不可变实例 —— 每账户新建一个空 Map 没有意义。
const EMPTY_IDS: ReadonlyMap<string, string> = new Map();

const noopLogger: SyncLogger = {
  debug() {},
  info() {},
  warning() {},
  error() {},
};

// **新旧世界唯一的接缝**:把公开的 `SyncDeps`(Promise 形状)翻译成上面这组服务。
//
// 两处「可选依赖」在这里就地补齐 —— mint / revalue 没注入就给个恒等实现,于是业务代码里
// 不再有 `if (deps.mint)` 这种分支:能力永远在,只是有时什么也不做。
//
// 下一步(出口也改成 Effect)这个函数删掉,调用方直接提供服务层。
export const layerFromDeps = (deps: SyncDeps): Layer.Layer<SyncServices> =>
  Layer.mergeAll(
    Layer.succeed(Accounts, {
      list: (userId) =>
        Effect.tryPromise({
          try: () => deps.listAccounts(userId),
          catch: (e) => depError("listAccounts", e),
        }),
      rawCreds: (userId) =>
        Effect.tryPromise({
          try: () => deps.listRawCreds(userId),
          catch: (e) => depError("listRawCreds", e),
        }),
    }),
    Layer.succeed(Balances, {
      fetch: (account, stored) =>
        Effect.tryPromise({
          try: () => deps.fetchBalances(account, stored),
          catch: toFetchBalancesError,
        }),
    }),
    Layer.succeed(Snapshots, {
      write: (userId, accountId, input) =>
        Effect.tryPromise({
          try: () => deps.writeSnapshot(userId, accountId, input),
          catch: (e) => depError("writeSnapshot", e),
        }),
    }),
    Layer.succeed(Tokens, {
      mint: deps.mint
        ? (userId, balances) =>
            Effect.tryPromise({
              try: () => deps.mint?.(userId, balances) ?? Promise.resolve(EMPTY_IDS),
              catch: (e) => depError("mint", e),
            })
        : () => Effect.succeed(EMPTY_IDS),
      revalue: deps.revalue
        ? (userId, connectorId, balances, idByRef) =>
            Effect.tryPromise({
              try: () =>
                deps.revalue?.(userId, connectorId, balances, idByRef) ?? Promise.resolve(null),
              catch: (e) => depError("revalue", e),
            })
        : () => Effect.succeed(null),
    }),
    Layer.succeed(SyncLog, deps.log ?? noopLogger),
  );
