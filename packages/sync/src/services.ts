import type { Balance } from "@folio/connectors-basic";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Context, Effect, HashMap, Layer, Logger, LogLevel } from "effect";
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
//
// 日志**不在这份名单里** —— 它是一个 Logger 层(见下方 forwardTo),不是要从上下文取的服务。

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

export type SyncServices = Accounts | Balances | Snapshots | Tokens;

// 没注入 mint 时的空答案。共享一个不可变实例 —— 每账户新建一个空 Map 没有意义。
const EMPTY_IDS: ReadonlyMap<string, string> = new Map();

// —— 日志:一个 Logger 层,不是一个服务 ——
//
// 业务代码只写 `Effect.logWarning("...")`,上下文字段(userId / accountId / connectorId)由
// `Effect.annotateLogs` 在**账户那一层标注一次**,此后该账户内所有日志自动都带上 ——
// 包括退避重试那条,它隔着 Schedule 也照样拿得到。手传 `log` 与 `fields` 的写法就此消失。
//
// 门限设 All:级别过滤是注入方(LogTape)的事,本层不替它筛 —— 与迁移前直调 `log.*` 一致。
// 不设的话 Effect 默认从 Info 起,`debug` 会在到达 LogTape 之前就被吃掉。
const forwardTo = (log: SyncLogger): Layer.Layer<never> =>
  Layer.merge(
    Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ annotations, logLevel, message }) => {
        const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
        const props = Object.fromEntries(HashMap.toEntries(annotations));
        switch (logLevel._tag) {
          case "Fatal":
          case "Error":
            return log.error(text, props);
          case "Warning":
            return log.warning(text, props);
          case "Debug":
          case "Trace":
            return log.debug(text, props);
          default:
            return log.info(text, props);
        }
      }),
    ),
    Logger.minimumLogLevel(LogLevel.All),
  );

// 没注入 logger:装一个哑的,而不是任由 Effect 默认 logger 往控制台打
//(迁移前的默认就是 no-op,测试不注入 log 时也指望这个)。
const silent: Layer.Layer<never> = Logger.replace(Logger.defaultLogger, Logger.none);

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
    deps.log ? forwardTo(deps.log) : silent,
  );
