import { env } from "cloudflare:workers";
import { FolioHttpClient } from "@folio/client-core";
import {
  type ConnectorManifest,
  registry as connectorRegistry,
  getConnector,
  selectProvider,
  validateCredentials,
} from "@folio/connectors";
import {
  type Balance,
  type ConnectorError,
  ConnectorFailure,
  fromProviderError,
  type ProviderNeeds,
} from "@folio/connectors-basic";
import { type AccountSafe, Database, type DbRequest, type WriteSnapshotInput } from "@folio/db";
import { Oracle, type OracleServices } from "@folio/oracle";
import type { ValuationMode } from "@folio/oracle-basic";
import {
  BalanceSource,
  depError,
  type FetchOutcome,
  AccountStore as SyncAccountStore,
  type SyncDepError,
  type SyncServices,
  SnapshotStore as SyncSnapshotStore,
  TokenOracle,
} from "@folio/sync";
import { Context, Effect, Layer } from "effect";
import type { InputSpec } from "@/lib/server/creds";
import { isComplete, openCreds } from "@/lib/server/creds";
import { revalue } from "./revalue";
import { isSyncableAccount } from "./status";

// server-only 编排装配(引 cloudflare:workers)。独立于 sync.ts —— triggerSync(server fn,被客户端 import)
// 只在其 handler 内引用本模块,handler 被剥离后客户端不会拉进 cloudflare:workers。cron(server.ts)直接引本模块。
// 数据访问经全局 db 门面;密钥/全局 key/tokens 走 cloudflare:workers 全局 env(fetch 与 scheduled 均可用)。

// 经 @folio/connectors 取余额。前置(缺凭据 / 校验 / 选 provider)走快回退。
// #37d 起 account.connectorId 直接即 connector 的 id。
//
// **出口是 Effect,不是 Promise。** 中间转一次就切断 context —— sync 那边的超时和中断就管不到
// provider 内部了(ADR 0035 迁移时实测过)。前置那几步(解密、校验)本身还是 Promise,
// 各自包一层 `tryPromise` 进来;它们的失败经 `fromProviderError` 归到「重试改变不了」那一类,
// 与迁移前一致(那时是非 `ProviderError` → `retryable: false`)。
const fetchViaConnector = (
  cid: string,
  manifest: ConnectorManifest,
  account: AccountSafe,
  stored: Record<string, string>,
  seeds: SeedCollector,
): Effect.Effect<FetchOutcome, ConnectorError, ProviderNeeds> =>
  Effect.gen(function* () {
    const specs = manifest.account.creds as unknown as InputSpec[]; // {key,type} 结构 = InputSpec
    if (!isComplete(specs, stored)) return { status: "needs-credentials" } satisfies FetchOutcome;
    const plain = yield* Effect.tryPromise({
      try: () => openCreds(specs, stored, env.SECRETS_KEY),
      catch: fromProviderError,
    });
    // 取数前再跑一次 account.creds 校验闸:脏/畸形 identifier 快速失败(归「重试改变不了」那类、
    // 隔离),不退化成"打坏地址 → 4xx → 白重试"。
    const validated = yield* Effect.tryPromise({
      try: () => validateCredentials(manifest.account.creds, plain),
      catch: fromProviderError,
    });
    const provider = selectProvider(manifest);
    if (!provider) {
      return yield* new ConnectorFailure({ message: `no provider for connector ${cid}` });
    }
    // PC 注入:从 env 按 provider 声明的 creds key 取默认值(最小权限:只注入声明的 key)。
    const providerCreds: Record<string, string> = {};
    for (const f of provider.creds) {
      const v = (env as unknown as Record<string, string | undefined>)[f.key];
      if (v != null) providerCreds[f.key] = v;
    }
    const ctx = {
      account: { id: account.id, label: account.label, connectorId: cid, creds: validated },
      creds: providerCreds,
    };
    // provider.fetchBalances 返回 { balances, note? }(note 重设计):balance 级单个 note 挂各 balance
    //(随 balances 透传 → snapshot_balances.note);顶层 note 为 account 级 Note[](整钱包)
    // → 透传 outcome.note → snapshots.note。
    //
    // **以前这里有个 `as unknown as`**,而它正好把「provider 的出口变成 Effect 了」这件事从类型上
    // 遮住了 —— 改契约那一刻全仓只有 provider 自己的测试报错,这一行照样编译通过、运行期
    // 会把一个 Effect 对象当成结果解构。强转就是这么吃掉真错误的,所以拆了。
    const { balances: rows, note } = yield* provider.fetchBalances(ctx);
    const totalUsd = rows.reduce((sum, b) => sum + b.value, 0);
    // provider 报的名字/图经 seeds 收给 mint 建行(新参考层);旧的 noteProviderAssets 双写已在 #202 拔掉。
    seeds.collect(rows);
    return { status: "ok", balances: rows, totalUsd, note } satisfies FetchOutcome;
  });

// provider 报的元信息(名字 / 图)在编排里会被丢掉 —— 快照只落 symbol/amount/value/kind 那几样,
// `SnapshotBalanceInput` 里没有 name/logo。但 mint 建代币行时要用它们(不然新币只剩 symbol、没图)。
//
// 所以在**取到余额那一刻**顺手收一份 seed(与 totalUsd 同一处、同一批数据),
// 写快照那一步按 tokenRef 取回。存活范围 = 一次 `makeSyncServicesLayer` 装配 = 一轮 sync,不跨请求。
// 这样 `@folio/sync` 与 `Balance` 契约都不用动 —— 平台字段那次的教训:派生出来的东西不该让
// provider 再报一遍(#193)。
interface SeedCollector {
  collect(rows: readonly Balance[]): void;
  of(tokenRef: string, symbol: string): { symbol: string; name?: string; providerLogo?: string };
}

function createSeedCollector(): SeedCollector {
  const bySeed = new Map<string, { symbol: string; name?: string; providerLogo?: string }>();
  return {
    collect(rows: readonly Balance[]): void {
      for (const b of rows) {
        if (!b.tokenRef || bySeed.has(b.tokenRef)) continue;
        bySeed.set(b.tokenRef, {
          // 归一(大写)是 store 的 key 口径,归一在调用方做。
          symbol: b.symbol.trim().toUpperCase(),
          name: b.name,
          providerLogo: b.logo,
        });
      }
    },
    // 没收到过(理论上不会:同一轮里 fetch 恒在 write 之前)→ 退回 symbol 一项。
    of(tokenRef: string, symbol: string) {
      return bySeed.get(tokenRef) ?? { symbol: symbol.trim().toUpperCase() };
    },
  };
}

// —— `SyncServices` 的 app 侧实现(#403 片 2)——
//
// **一次装配 = 一个用户的一轮同步。** 四个能力的方法签名里没有 userId —— 它由外面那次
// 装配点(`forUser` / `runForUser`)供上的 db / 参考层服务吃掉了(ADR 0037)。
//
// `seeds` 与估值模式都建在**这一层**:它们的存活范围恰好是「一轮同步」,与 layer 的生命周期同长。
// 以前那个 Promise 形状的 deps 得按 userId 分桶缓存估值模式(一份 deps 跨多用户),现在一个用户一层,
// 读一次存进闭包就够 —— 那个 Map 连同它的分桶逻辑一起没了。
// db 与参考层的错误通道都是 `never`(ADR:D1 挂了走 defect),而编排靠**类型化**的 `SyncDepError`
// 做隔离 —— `account.ts` 的 `bestEffort`(认币/重估降级)与 `syncAccount` 末尾的 `catchAll`
// (逐账户隔离)都只接类型化失败;逐用户隔离在 `round.ts` 的 `fanOutAllUsers`(那层兜的是 Cause),逐账户的队列消息各是各的调用。
//
// 以前这道翻译是**免费**的:每个 dep 都经一次 `runPromise` 边界,defect 变成 promise rejection,
// 再被 `tryPromise({ catch: depError })` 收成类型化失败。边界一拿掉,它就得显式补上。
const asDep =
  (step: Parameters<typeof depError>[0]) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | SyncDepError> =>
    effect.pipe(Effect.catchAllDefect((cause) => Effect.fail(depError(step, cause))));

/**
 * app 侧对 `@folio/sync` 那四个能力的接线。
 *
 * `only` 给的时候,这一轮**只跑名单里那些账户** —— 队列 consumer 一条消息一个账户,收口成那一个
 * (名单由开轮那一步定死,ADR 0048;这里不按组合再算一遍)。不给 = 不收口。
 */
interface SyncScope {
  only: ReadonlySet<string>;
}

/**
 * 同一份接线,**造成一份 context 而不是一张 Layer**(FOL-83 第二轮)。队列 consumer 每条
 * `sync-account` 消息装一次:以前是 `Layer.mergeAll` 五张子 layer(并行合并时每张 fork 一条 fiber、
 * 一张 memo 表、一个 scope),在一条总共该 10ms 的消息里是实打实的几毫秒;四个能力本身只是闭包。
 * 出网那一格(`FolioHttpClient`)仍经它自己的 layer 建 —— 那是 `@effect/platform` 的东西,
 * 这里不去拆它。`makeSyncServicesLayer` 就是这一份外面包一层,两条路逐字同一套接线。
 */
export const makeSyncServices = (
  scope?: SyncScope,
): Effect.Effect<
  Context.Context<SyncServices>,
  never,
  // 端口那八个不在这里(#504 T17):`mint` / `revalue` 自 T12 起都经聚合 `Oracle`。
  // `DbRequest`:这一轮是谁的、那一个 D1 句柄 —— 建的时候各服务抓一份(见下),
  // 于是 `@folio/sync` 那四个能力的 `R` 仍是 `never`。
  Database | OracleServices | DbRequest
> =>
  Effect.gen(function* () {
    // 一轮 sync 共一份 seed 收集器:取余额那头收,写快照那头取(见 SeedCollector 的定义)。
    const seeds = createSeedCollector();
    const { accounts, snapshots, settings } = yield* Database;
    // 这一轮的连接与用户(ADR 0054):db 的 op 在跑的那一刻才取它们,而编排那头的能力
    // `R` 是 `never` —— 所以在建这一份(= 这一轮)的时候抓一份,每个方法出口 provide 进去。
    // 一轮一份,抓的就是这一轮的那一份,不会串到别的请求。
    const request = yield* Effect.context<DbRequest>();
    // 参考层那几个服务已经在外面那次装配里装好了 —— 抓住 context,别让它们
    // 漏进本服务的 `R`(CODING.md:服务对外的 `R` 恒是 `never`)。
    // **抓的是服务不是端口**(#504 T17):`mint` / `revalue` 现在都经聚合 `Oracle`,
    // 端口那八个本来就不该出现在这一层。连这一轮的连接与用户一起抓(同上面 `request`)。
    const oracle = yield* Effect.context<OracleServices | DbRequest>();
    // 出网:provider 声明「我要出网」,这里满足它。
    const http = yield* Effect.provide(Effect.context<ProviderNeeds>(), FolioHttpClient);
    // **这一轮跑哪些账户,开轮那一步已经定死了**(ADR 0048):队列那条路收口成消息里的
    // 那一个账户,不给就不收口。
    const only = scope?.only ?? null;
    // 估值模式一轮读一次,**惰性**:纯链上的一轮同步压根不重估,不该为此白发一次 D1 查询。
    // 以前得按 userId 分桶缓存(一份 deps 跨多用户),现在一个用户一份,一个闭包变量就够。
    let mode: ValuationMode | undefined;
    const modeOnce = Effect.suspend(() =>
      mode !== undefined
        ? Effect.succeed(mode)
        : Effect.map(settings.get().pipe(Effect.provide(request)), (row) => {
            mode = row.valuationMode;
            return row.valuationMode;
          }),
    );
    return Context.make(SyncAccountStore, {
      // 归档账户跳过同步(不产生新快照);manual 不是同步源(ADR 0018:当下值由 creds 现造,
      // 不写快照)→ 一并过滤。编排只见活跃的可同步账户(判别走纯 isSyncableAccount)。
      list: () =>
        Effect.map(accounts.list(), (rows) =>
          rows.filter(isSyncableAccount).filter((a) => only == null || only.has(a.id)),
        ).pipe(Effect.provide(request), asDep("listAccounts")),
      // 批量取全用户 creds(消 syncAccount 的 N+1)
      rawCreds: () => accounts.listRawCreds().pipe(Effect.provide(request), asDep("listRawCreds")),
    }).pipe(
      Context.add(SyncSnapshotStore, {
        // **同步落的快照按钟点折叠**(#461):同账户、同一个钟点里已有的那份被这次覆盖。
        // 同步写的是「此刻的状态」,而读侧的趋势图本来就只画每个钟点的最后一个点 —— 同钟点里
        // 更早的那些份存了也看不到。开关默认是关的(默认追加),导入那条路要的正是默认值:
        // 它恢复的是历史事实,不能折叠。判据与理由见 `SnapshotStore.write` 的文档注释。
        // `orDie` 在 `asDep` 之前:`write` 会 fail `NotFound`(账户归属断言),而这条路的
        // accountId 来自本用户自己的账户列表 —— 到这一步还找不到就是 bug。`orDie` 把它变回
        // defect,`asDep` 再照旧收成 `SyncDepError`,与改造前逐字一致。
        write: (accountId: string, input: WriteSnapshotInput) =>
          snapshots
            .write(accountId, input, { collapseSameHour: true })
            .pipe(Effect.provide(request), Effect.orDie, asDep("writeSnapshot")),
      }),
      Context.add(BalanceSource, {
        // 取余额:account.connectorId → connector manifest → fetchViaConnector(缺凭据/解密/校验/
        // 取数在其内);SECRETS_KEY 只在本层(app)见。无 manifest 视为数据错误(由 syncAccount
        // 逐账户隔离,不阻断其余)。
        fetch: (account, stored) => {
          const cid = account.connectorId;
          const manifest = getConnector(connectorRegistry, cid);
          if (!manifest) {
            return Effect.fail(
              new ConnectorFailure({ message: `no connector for connectorId ${cid}` }),
            );
          }
          // 「这个用户同时在飞几发上游」以前由 cron 递进来的一把闸管(多轮共用);FOL-86 起 cron 的
          // 账户一条消息一次调用,闸递不过去,改由队列 consumer 的 `max_concurrency` 顶上(wrangler.jsonc)。
          return fetchViaConnector(cid, manifest, account, stored, seeds);
        },
      }),
      Context.add(TokenOracle, {
        // 认币:每笔余额的 tokenRef 换成 token_id,认定就此冻进快照(ADR 0021 / #200)。
        // 上游失败归 `SyncDepError` —— 编排把 mint / revalue 各当一个 best-effort 降级点
        // (见 account.ts 的 bestEffort),**不能让它变成 defect**,否则整个账户这轮就没了。
        mint: (rows) => {
          const refs = rows.flatMap((b) =>
            b.tokenRef ? [{ ref: b.tokenRef, seed: seeds.of(b.tokenRef, b.symbol) }] : [],
          );
          if (refs.length === 0) {
            return Effect.succeed(new Map<string, string>() as ReadonlyMap<string, string>);
          }
          return Effect.flatMap(Oracle, (o) => o.tokens.mint(refs)).pipe(
            Effect.provide(oracle),
            Effect.mapError((e) => depError("mint", e)),
            asDep("mint"),
          );
        },
        // 写快照前重估(oracle 多源 Phase 3):按 mode 定 value + 非盯市类型捕获 selfPrice。
        // 盯市语义由 connector 的 manifest.valuation 声明(不靠 app 硬编码名单)。
        revalue: (connectorId, rows, idByRef) =>
          Effect.flatMap(modeOnce, (valuation) =>
            revalue(
              getConnector(connectorRegistry, connectorId)?.valuation === "mark-to-market",
              rows,
              idByRef,
              valuation,
            ),
          ).pipe(
            Effect.provide(oracle),
            Effect.mapError((e) => depError("revalue", e)),
            asDep("revalue"),
          ),
      }),
      Context.merge(http),
    );
  });

export const makeSyncServicesLayer = (
  scope?: SyncScope,
): Layer.Layer<SyncServices, never, Database | OracleServices | DbRequest> =>
  Layer.effectContext(makeSyncServices(scope));
