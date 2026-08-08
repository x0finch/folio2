import { FolioHttpClient } from "@folio/client-core";
import type { Balance, ConnectorError, ProviderNeeds } from "@folio/connectors-basic";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Context, Effect, HashMap, Layer, Logger, LogLevel } from "effect";
import { depError, type SyncDepError } from "./errors";
import type { FetchOutcome, SyncDeps, SyncLogger } from "./types";

// 编排要用的**能力**,一个一个具名。业务代码从上下文取能力,不再一层层透传 deps / account /
// stored 这些「材料」—— 谁需要什么,签名上看得见。
//
// 每个能力的错误类型也写在这:只有取余额会驱动决策(重不重试、等多久),所以它单独一个错误类型;
// 其余都是 SyncDepError。
//
// **命名:单数 + 角色后缀,不用复数集合名。** `BalanceSource` 而不是 `Balances` —— 后者摆在这个
// 仓里看着就是 `Balance[]`(`@folio/connectors-basic` 真有 `Balance` 这个类型)。Effect 官方也是
// 这个路子:`FileSystem` 不叫 `Files`、`SqlClient` 不叫 `Queries`、`Logger` 不叫 `Logs`。
// 后缀选仓里已有的领域词 —— 参考层叫 oracle,所以是 `TokenOracle`。
//
// 日志**不在这份名单里** —— 它是一个 Logger 层(见下方 forwardTo),不是要从上下文取的服务。
//
// **方法签名里没有 userId**(ADR 0037,#403 片 1)。这些能力是**按用户建的** —— `layerFromDeps`
// 在装配那一刻把 userId 吃掉,于是「拿错用户」在编译期就发生不了,与 `@folio/db` 的 store、
// 参考层的 store 是同一个形状。
//
// **但内核入口仍然收 userId**(`syncAccount(userId, …)` / `syncUserStream(userId)`),那不是漏改:
// 它在那儿只有一个用途 —— **日志上下文**。cron 没有请求级的 ALS 上下文,userId 得显式带进去
// (P6.7)。授权面和可观测面是两个理由,所以两种处理:前者进装配,后者留签名。

export class AccountStore extends Context.Tag("sync/AccountStore")<
  AccountStore,
  {
    readonly list: () => Effect.Effect<readonly AccountSafe[], SyncDepError>;
    readonly rawCreds: () => Effect.Effect<readonly AccountRawCreds[], SyncDepError>;
  }
>() {}

export class BalanceSource extends Context.Tag("sync/BalanceSource")<
  BalanceSource,
  {
    readonly fetch: (
      account: AccountSafe,
      stored: Record<string, string>,
    ) => Effect.Effect<FetchOutcome, ConnectorError, ProviderNeeds>;
  }
>() {}

export class SnapshotStore extends Context.Tag("sync/SnapshotStore")<
  SnapshotStore,
  {
    readonly write: (
      accountId: string,
      input: WriteSnapshotInput,
    ) => Effect.Effect<string, SyncDepError>;
  }
>() {}

// 认币与重估合成一个能力:它们都是「参考层帮我把这批余额认清楚 / 定好价」,
// 而且顺序上绑死(mint 先、revalue 拿它的答案)。
export class TokenOracle extends Context.Tag("sync/TokenOracle")<
  TokenOracle,
  {
    readonly mint: (
      balances: Balance[],
    ) => Effect.Effect<ReadonlyMap<string, string>, SyncDepError>;
    // null = 没重估。调用方据此决定要不要重算 totalUsd —— 只有真重估过才重算,
    // 否则保留 provider 报的那个数(它未必等于各行之和)。
    readonly revalue: (
      connectorId: string,
      balances: Balance[],
      idByRef: ReadonlyMap<string, string>,
    ) => Effect.Effect<Balance[] | null, SyncDepError>;
  }
>() {}

// 编排跑起来需要的全部能力。**`ProviderNeeds`(出网)也在里面** —— provider 现在自己发请求,
// 而它声明「我需要出网」而不是自己 provide 一个:后者的话测试就换不掉它了。
// 装配那头(`apps/web`)提供 `FolioHttpClient`,测试提供一个假的。
export type SyncServices =
  | AccountStore
  | BalanceSource
  | SnapshotStore
  | TokenOracle
  | ProviderNeeds;

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
// **导出**(#403 片 2):调用方直接提供服务、不再经 `SyncDeps` 之后,这一层得由它自己接上 ——
// 否则 sync 的日志会落进调用方那个 runtime 的默认 logger 里。`apps/web` 的那个把类目写死成
// `["folio","oracle"]`、也没设最低级别,接错的后果是**类目串味 + debug 全被吞掉**,而且是静默的。
export const syncLoggerLayer = (log: SyncLogger): Layer.Layer<never> =>
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
// **收 userId**(#403 片 1):公开的 `SyncDeps` 仍是「每个方法各带一个 userId」的旧形状 ——
// 那是下一片要拆的东西。在这之前,由这一层把 userId 吃掉,于是包内业务代码已经看不见它了。
// 一份 deps 服务多个用户(cron)照旧成立:每个用户各建一层。
//
// 下一步(出口也改成 Effect)这个函数删掉,调用方直接提供服务层。
export const layerFromDeps = (deps: SyncDeps, userId: string): Layer.Layer<SyncServices> =>
  Layer.mergeAll(
    // 出网。**在这里补上而不是让调用方给** —— 本包的公开出口仍是 Promise 形状(内部 `runPromise`),
    // 所以这一层必须是完整的。provider 声明「我要出网」,这里满足它。
    // 测试不受影响:它们注入的 `fetchBalances` 压根不出网,而 provider 自己的测试在 entry 那边
    // provide 一个假 `HttpClient`。
    FolioHttpClient,
    Layer.succeed(AccountStore, {
      list: () =>
        Effect.tryPromise({
          try: () => deps.listAccounts(userId),
          catch: (e) => depError("listAccounts", e),
        }),
      rawCreds: () =>
        Effect.tryPromise({
          try: () => deps.listRawCreds(userId),
          catch: (e) => depError("listRawCreds", e),
        }),
    }),
    Layer.succeed(BalanceSource, {
      // **没有 `Effect.tryPromise`** —— provider 契约的出口已经是 Effect,注入进来的就是 Effect,
      // 原样转发。以前这里要包一层,顺带把 `ProviderError` 翻译成本包自己的错误类型;
      // 那两件事随契约改造一起没了。
      fetch: (account, stored) => deps.fetchBalances(account, stored),
    }),
    Layer.succeed(SnapshotStore, {
      write: (accountId, input) =>
        Effect.tryPromise({
          try: () => deps.writeSnapshot(userId, accountId, input),
          catch: (e) => depError("writeSnapshot", e),
        }),
    }),
    Layer.succeed(TokenOracle, {
      mint: deps.mint
        ? (balances) =>
            Effect.tryPromise({
              try: () => deps.mint?.(userId, balances) ?? Promise.resolve(EMPTY_IDS),
              catch: (e) => depError("mint", e),
            })
        : () => Effect.succeed(EMPTY_IDS),
      revalue: deps.revalue
        ? (connectorId, balances, idByRef) =>
            Effect.tryPromise({
              try: () =>
                deps.revalue?.(userId, connectorId, balances, idByRef) ?? Promise.resolve(null),
              catch: (e) => depError("revalue", e),
            })
        : () => Effect.succeed(null),
    }),
    deps.log ? syncLoggerLayer(deps.log) : silent,
  );
