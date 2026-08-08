import { FolioHttpClient } from "@folio/client-core";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Effect, Layer, Logger } from "effect";
import { depError } from "../src/errors";
import {
  AccountStore,
  BalanceSource,
  SnapshotStore,
  type SyncServices,
  syncLoggerLayer,
  TokenOracle,
} from "../src/services";
import type { FetchOutcome, SyncLogger } from "../src/types";

// 用例共用的假装配(#403 片 3)。
//
// 以前测试注入的是 `SyncDeps` —— 一个 Promise 形状的对象,由包内的 `layerFromDeps` 翻成服务。
// 那层翻译连同 `SyncDeps` 一起删掉了(调用方现在自己提供服务),所以测试也直接**提供 layer**。
//
// 这正是 CODING.md 那条:**别留第二条路** —— 假的和真的都经同一条 `Tag → Layer`,用例走的就是
// 生产那条路,不存在「测试走 `make`、生产走 Layer」两条各自演化的可能。
//
// 默认值挑的是「最无聊的那一种」:没有账户、没有凭据、取余额恒成功且空、认币空、不重估。
// 每个用例只覆盖它关心的那一两样。

export interface FakeOptions {
  accounts?: readonly AccountSafe[] | (() => Promise<readonly AccountSafe[]>);
  rawCreds?: readonly AccountRawCreds[];
  fetch?: BalanceSource["Type"]["fetch"];
  mint?: TokenOracle["Type"]["mint"];
  revalue?: TokenOracle["Type"]["revalue"];
  log?: SyncLogger;
}

export interface Fakes {
  /** 一个用户的一次装配 —— 与生产同形状(`SyncServices` 是 per-user 的)。 */
  layer: Layer.Layer<SyncServices>;
  /** 写出去的快照,按顺序。 */
  writes: Array<{ accountId: string; input: WriteSnapshotInput }>;
}

const okEmpty: FetchOutcome = { status: "ok", balances: [], totalUsd: 0 };

export const fakeServices = (options: FakeOptions = {}): Fakes => {
  const writes: Fakes["writes"] = [];
  const accounts = options.accounts ?? [];
  const layer = Layer.mergeAll(
    FolioHttpClient,
    // 不注入 logger 就装个哑的 —— 别让 Effect 默认那个往控制台打(迁移前的默认就是 no-op)。
    options.log ? syncLoggerLayer(options.log) : Logger.replace(Logger.defaultLogger, Logger.none),
    Layer.succeed(AccountStore, {
      // **失败要归到 `SyncDepError`**,不能让它变成 defect —— 生产那条路(以前的 `layerFromDeps`,
      // 现在 app 的 `syncServicesLayer`)就是这么翻的,而「用户级失败被隔离成一个 failed」这条
      // 性质全靠它:`Sweep.userTally` 的 `catchAll` 只接类型化失败。
      list: () =>
        typeof accounts === "function"
          ? Effect.tryPromise({ try: accounts, catch: (e) => depError("listAccounts", e) })
          : Effect.succeed(accounts),
      rawCreds: () => Effect.succeed(options.rawCreds ?? []),
    }),
    Layer.succeed(SnapshotStore, {
      write: (accountId, input) =>
        Effect.sync(() => {
          writes.push({ accountId, input });
          return `snap-${accountId}`;
        }),
    }),
    Layer.succeed(BalanceSource, { fetch: options.fetch ?? (() => Effect.succeed(okEmpty)) }),
    Layer.succeed(TokenOracle, {
      mint: options.mint ?? (() => Effect.succeed(new Map<string, string>())),
      revalue: options.revalue ?? (() => Effect.succeed(null)),
    }),
  );
  return { layer, writes };
};
