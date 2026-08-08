import type { Balance, ConnectorError, ProviderNeeds } from "@folio/connectors-basic";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Context, type Effect, HashMap, Layer, Logger, LogLevel } from "effect";
import type { SyncDepError } from "./errors";
import type { FetchOutcome, SyncLogger } from "./types";

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
// 日志**不在这份名单里** —— 它是一个 Logger 层(见下方 syncLoggerLayer),不是要从上下文取的服务。
//
// **方法签名里没有 userId**(ADR 0037,#403)。这些能力是**按用户建的** —— 装配方(`apps/web` 的
// `syncServicesLayer`)在建这一层那一刻就把 userId 吃掉,于是「拿错用户」在编译期就发生不了,
// 与 `@folio/db` 的 store、参考层的 store 是同一个形状。
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

// —— 日志:一个 Logger 层,不是一个服务 ——
//
// 业务代码只写 `Effect.logWarning("...")`,上下文字段(userId / accountId / connectorId)由
// `Effect.annotateLogs` 在**账户那一层标注一次**,此后该账户内所有日志自动都带上 ——
// 包括退避重试那条,它隔着 Schedule 也照样拿得到。手传 `log` 与 `fields` 的写法就此消失。
//
// 门限设 All:级别过滤是注入方(LogTape)的事,本层不替它筛 —— 与迁移前直调 `log.*` 一致。
// 不设的话 Effect 默认从 Info 起,`debug` 会在到达 LogTape 之前就被吃掉。
// 注入式 logger 的转发层。**生产不用它了**(#403 片 3:Promise 出口没了,类目改由日志自己带,
// 见 apps/web 的 `logCategory`)—— 留着是给测试:用例要断言「哪条日志、什么级别、带哪些字段」,
// 得有个地方把 Effect 的日志接出来。
//
// 别在生产那边叠这么一层:`Logger.replace` 是「remove(default) + add」,外层已经换过 default 的话
// 内层那次 remove 是空操作,两个转发器同时在,每条日志写两遍(#403 片 2 实测过)。
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
