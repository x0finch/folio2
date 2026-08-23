import { env } from "cloudflare:workers";
import { FolioHttpClient, type UpstreamError } from "@folio/client-core";
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
import { type AccountSafe, Database, type NotFound, type WriteSnapshotInput } from "@folio/db";
import { Oracle, type OraclePorts, type OracleServices } from "@folio/oracle";
import type { ValuationMode } from "@folio/oracle-basic";
import {
  type AccountSyncResult,
  BalanceSource,
  depError,
  type FetchOutcome,
  Sweep,
  type SweepResult,
  AccountStore as SyncAccountStore,
  type SyncDepError,
  type SyncServices,
  SnapshotStore as SyncSnapshotStore,
  TokenOracle,
} from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { Cause, Effect, Exit, Layer, type Stream } from "effect";
import type { InputSpec } from "@/lib/server/creds";
import { isComplete, openCreds } from "@/lib/server/creds";
import { manualBalancesForWarm } from "@/lib/server/manual/store";
import { forUser, type UserServices, userLayer } from "@/lib/server/runtime";
import { warmHeldPrices } from "@/lib/server/tokens/enrich";
import { userDisplayBalances } from "@/lib/server/tokens/model";
import { recordDefiLogosOf } from "./defi-logos";
import { warmPlatforms } from "./platforms";
import { revalue } from "./revalue";
import { isSyncableAccount } from "./syncable";

// server-only 编排装配(引 cloudflare:workers)。独立于 sync.ts —— triggerSync(server fn,被客户端 import)
// 只在其 handler 内引用本模块,handler 被剥离后客户端不会拉进 cloudflare:workers。cron(server.ts)直接引本模块。
// 数据访问经全局 db 门面;密钥/全局 key/tokens 走 cloudflare:workers 全局 env(fetch 与 scheduled 均可用)。

// 同步后预热代币缓存:取该用户最新快照的全部余额 → warm(top-N + 逐 spot/manual 行懒解析)。
// best-effort(warmTokens 内部吞错),让下次总览能 cache-only 富化出价/logo/涨跌。cron 与手动 sync 共用。
//
// **整段是一个 effect,装配一次。** 以前这里 await 了四次 `runOracle`,即一趟预热建四套 store、
// 跑四个互不相干的 fiber;现在四步共一份 context。Effect 官方那句「`run*` 尽量放在程序的边缘」
// 说的就是这个 —— 边界越靠外,能一路传下去的东西(中断、超时、日志上下文)越多。
//
// **它自己不装配**(#394 T5 改):导出的是没接依赖的那一半,userId 由调用方装的那层给。
// 这样单账户同步(`syncAccount` server fn)能把「读账户 → 同步 → 预热」拼进**自己那一次**装配里,
// 而不是在同一个请求里再建一套 store。cron 与流式同步各自在自己的边缘装(见下面两个出口)。
export const warmTokens: Effect.Effect<
  void,
  UpstreamError | NotFound,
  Database | OracleServices | OraclePorts
> = Effect.gen(function* () {
  const syncLog = getLogger(["folio", "web", "sync"]);
  const db = yield* Database;
  const [snapshots, accounts] = yield* Effect.all([db.snapshots.latest(), db.accounts.list()], {
    concurrency: 2,
  });
  // manual 已退出快照(ADR 0018)→ 预热额外从 manual 的 creds 收集合成余额,否则纯 manual 用户的币暖不到实时价。
  // 与 refreshStalePrices 经同一 userDisplayBalances 收口(三门同源)。
  const manualBalances = yield* manualBalancesForWarm(accounts);
  const report = yield* warmHeldPrices(userDisplayBalances(snapshots, manualBalances));
  // **暖不上价要喊一声。** 参考层已经按类型接住了上游那一档并记了一行,但那条日志在
  // 「oracle」类目下、看起来像一次普通降级;这里再记一条同步类目的 warn —— 「这一轮的持仓价
  // 没暖上」是同步的结果,连着几天都这样该有人发现(#375 第 3 步要的抓手)。
  if (report.degraded) syncLog.warn("held prices partially warmed", { ...report });
  else syncLog.debug("held prices warmed", { ...report });
  // 平台元数据 + DeFi 协议图各自兜住(一个失败不拖垮另一个,也不拖垮下面的汇率与目录)。
  // 两者的错误通道都是 `never`,所以这里兜的是 **defect** —— 自家 bug 或 db 抛的东西。
  // `catchAllCause` 而不是 `catchAll`:后者只接类型化失败,接不住 defect(见 warmAllUsers 的注释)。
  // 快照直接传给它 —— 它以前自己再读一遍(一次预热两趟同样的 D1 查询)。
  yield* warmPlatforms(snapshots).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => syncLog.warn("warmPlatforms failed", { error: Cause.pretty(cause) })),
    ),
  );
  // DeFi 协议 logo:URL 就在刚读到的 snapshots 的 meta 里,收集出来落缓存(供 /api/logo/defi O(1) 读)。
  yield* recordDefiLogosOf(snapshots).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => syncLog.warn("recordDefiLogos failed", { error: Cause.pretty(cause) })),
    ),
  );
  // 汇率:`warm` 现在自己降级(上游挂了记一行、什么都不写),所以这里不再包一层 catch ——
  // 那层 catch 连自己的 bug 一起吞,而参考层已经把「上游的锅」与「我们的锅」分开了。
  yield* Effect.flatMap(Oracle, (o) => o.fx.warm());
  // 新参考层的目录(市值前 N 名):**唯一主动让它跟上的那条路**(#216)。
  // 写路径(mint)按设计永不刷 —— 它只要「哪个币叫 POL」,不该为此让用户等;选币下拉只在
  // 用户打开时才刷 —— 从不开下拉的用户目录会冻住,此后新进前 1000 的币永远认不出来。
  // 内部按一周的 TTL 门控,所以绝大多数同步在这里零请求。放这里正因为这是 best-effort 的位置。
  const rows = yield* Effect.flatMap(Oracle, (o) => o.tokens.refreshCatalogue());
  syncLog.debug("catalogue warmed", { rows });
});

// 一个用户的预热,**装配好了但还没跑**。cron 用它(把 N 个用户拼进自己那一个 effect)。
const warmTokensFor = (userId: string): Effect.Effect<void, Error> => forUser(userId, warmTokens);

// sweep 收尾用:逐用户预热,**各自兜住**(#375 第 2 步 · 纵深防御)。预热是尽力而为(供次日总览
// cache-only 富化),一个用户失败绝不该让后面的用户排不上队,更不该把整次 cron 拖成异常收尾。
//
// **为什么不是 `Effect.partition`。** 官方给的错误累积算子(`partition` / `validateAll`)内部都是
// `Effect.either`,只累积**类型化失败**;defect(我们自己代码抛的 TypeError、db 抛的东西)照样
// 炸穿整个 effect —— 那正是 #375 要兜的那一类。`Effect.exit` 收的是整个 `Cause`,两类都进来,
// 才等价于原来那圈 try/catch。
//
// 串行(默认 concurrency)是有意的:与原来的 for-await 一致,且 cron 一次调用的子请求数有限。
// 每条失败只记 `error`(不带 userId),与本文件其余 best-effort 一致(P6.7);「哪个用户」的
// 可观测性交给返回的计数 + 调用方一条汇总日志。
// `warmOne` 可注入,只为单测能让指定用户失败;生产路径用默认的 `warmTokensFor`。
export const warmAllUsers = (
  userIds: readonly string[],
  warmOne: (userId: string) => Effect.Effect<void, Error> = warmTokensFor,
): Effect.Effect<{ warmed: number; failed: number }> =>
  Effect.gen(function* () {
    const syncLog = getLogger(["folio", "web", "sync"]);
    const exits = yield* Effect.forEach(userIds, (userId) => Effect.exit(warmOne(userId)));
    let warmed = 0;
    let failed = 0;
    for (const exit of exits) {
      if (Exit.isSuccess(exit)) {
        warmed++;
      } else {
        failed++;
        syncLog.warn("warmTokens failed, user skipped", { error: Cause.pretty(exit.cause) });
      }
    }
    return { warmed, failed };
  });

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
// 写快照那一步按 tokenRef 取回。存活范围 = 一次 `syncServicesLayer` 装配 = 一轮 sync,不跨请求。
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
// 装配点那一次(`userLayer(userId)`)供上的 db / 参考层服务吃掉了(ADR 0037)。
//
// `seeds` 与估值模式都建在**这一层**:它们的存活范围恰好是「一轮同步」,与 layer 的生命周期同长。
// 以前那个 Promise 形状的 deps 得按 userId 分桶缓存估值模式(一份 deps 跨多用户),现在一个用户一层,
// 读一次存进闭包就够 —— 那个 Map 连同它的分桶逻辑一起没了。
// db 与参考层的错误通道都是 `never`(ADR:D1 挂了走 defect),而编排靠**类型化**的 `SyncDepError`
// 做隔离 —— `account.ts` 的 `bestEffort`(认币/重估降级)、`syncAccount` 末尾的 `catchAll`
// (逐账户隔离)、`Sweep.userTally` 的 `catchAll`(逐用户隔离),三处都只接类型化失败。
//
// 以前这道翻译是**免费**的:每个 dep 都经一次 `runPromise` 边界,defect 变成 promise rejection,
// 再被 `tryPromise({ catch: depError })` 收成类型化失败。边界一拿掉,它就得显式补上。
const asDep =
  (step: Parameters<typeof depError>[0]) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | SyncDepError> =>
    effect.pipe(Effect.catchAllDefect((cause) => Effect.fail(depError(step, cause))));

export const syncServicesLayer: Layer.Layer<
  SyncServices,
  never,
  Database | OracleServices | OraclePorts
> = Layer.unwrapEffect(
  Effect.sync(() => {
    // 一轮 sync 共一份 seed 收集器:取余额那头收,写快照那头取(见 SeedCollector 的定义)。
    // 建在 `unwrapEffect` 里而不是各子 layer 里 —— 两个能力要共用同一份,而 `Layer.mergeAll`
    // 的成员之间传不了值。
    const seeds = createSeedCollector();
    return Layer.mergeAll(
      // 出网:provider 声明「我要出网」,这里满足它。
      FolioHttpClient,
      Layer.effect(
        SyncAccountStore,
        Effect.map(Database, ({ accounts }) => ({
          // 归档账户跳过同步(不产生新快照);manual 不是同步源(ADR 0018:当下值由 creds 现造,
          // 不写快照)→ 一并过滤。编排只见活跃的可同步账户(判别走纯 isSyncableAccount)。
          list: () =>
            Effect.map(accounts.list(), (rows) => rows.filter(isSyncableAccount)).pipe(
              asDep("listAccounts"),
            ),
          // 批量取全用户 creds(消 syncAccount 的 N+1)
          rawCreds: () => accounts.listRawCreds().pipe(asDep("listRawCreds")),
        })),
      ),
      Layer.effect(
        SyncSnapshotStore,
        Effect.map(Database, ({ snapshots }) => ({
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
              .pipe(Effect.orDie, asDep("writeSnapshot")),
        })),
      ),
      Layer.succeed(BalanceSource, {
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
          return fetchViaConnector(cid, manifest, account, stored, seeds);
        },
      }),
      Layer.effect(
        TokenOracle,
        Effect.gen(function* () {
          const settings = (yield* Database).settings;
          // 参考层那几个服务已经在外面那次装配里装好了 —— 抓住 context,别让它们
          // 漏进本服务的 `R`(CODING.md:服务对外的 `R` 恒是 `never`)。
          const oracle = yield* Effect.context<OracleServices | OraclePorts>();
          // 估值模式一轮读一次,**惰性**:纯链上的一轮同步压根不重估,不该为此白发一次 D1 查询。
          // 以前得按 userId 分桶缓存(一份 deps 跨多用户),现在一个用户一层,一个闭包变量就够。
          let mode: ValuationMode | undefined;
          const modeOnce = Effect.suspend(() =>
            mode !== undefined
              ? Effect.succeed(mode)
              : Effect.map(settings.get(), (row) => {
                  mode = row.valuationMode;
                  return row.valuationMode;
                }),
          );
          return {
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
          };
        }),
      ),
    );
  }),
);

// 一个用户的一轮同步,**装配好了但还没跑**。流式端点与 cron 各取所需。
//
// `provideMerge` 而不是 `provide`:底下那层(`Database` + 参考层)也透出去 —— 流式那条路的
// 收尾(`warmTokens`)要的正是它,而它必须与同步内核用**同一次构建**出来的那一份
//(否则一个请求两个 `DbClient`)。cron 那条路只用到 `SyncServices`,多透出来不花什么。
const syncFor = (userId: string): Layer.Layer<SyncServices | UserServices> =>
  Layer.provideMerge(syncServicesLayer, userLayer(userId));

/**
 * `/api/sync` 的一轮:**流、收尾,和它们共用的那一次装配** —— 三件一起出去,不在这里 provide。
 *
 * 以前这里出的是「已经 provide 好的流」,而收尾(`warmTokensForUser`)自己在另一个 `runAtEdge`
 * 里再装一次 —— 同一个请求两个 `DbClient`。**Layer memoisation 的作用域是一次构建**,所以光传
 * 同一个 layer 引用没用,必须是同一次 provide;要做到这一点,provide 那一下就得挪到「同时看得见
 * 两半」的地方,也就是 `ndjsonRound` 里(#504 T12)。
 *
 * `syncFor` 因此改用 `provideMerge`:同步内核要的 `SyncServices` 与收尾要的 `UserServices`
 * 都得在场,而且必须是同一次构建出来的那一份。
 */
export const syncRoundFor = (userId: string) => ({
  results: Sweep.syncUserStream(userId) as Stream.Stream<
    AccountSyncResult,
    SyncDepError,
    SyncServices | UserServices
  >,
  // 同步完预热代币缓存(best-effort),让下次总览能 cache-only 富化新价。
  afterRound: warmTokens,
  layer: syncFor(userId),
});

// cron 的全量 sweep:**逐用户各装一次**,再把小计加起来。
//
// 这个循环以前住在 `@folio/sync` 的壳里。服务变成 per-user 之后它就不该在包里了 ——
// 一份服务服务不了多个用户,「逐用户装配 + 累加」属于做装配的这一方。搬过来之后它与紧挨着的
// `warmAllUsers` 形状一模一样,cron 的两步收尾读起来是同一件事。
//
// **串行不是遗漏,是有意的**:cron 一次调用有 CPU / subrequest 预算,几十个用户并发会顶穿
// (见 server.ts 里两个 trigger 拆开的理由)。用 `Effect.forEach` 的默认串行语义,
// **别顺手加 concurrency**。
//
// `tallyOne` 可注入,只为单测能观察到「一个跑完才起下一个」—— 与紧邻的 `warmAllUsers` 同款理由。
// 这个钩子是必要的:循环从 `@folio/sync` 搬过来之后,包里那条串行用例钉的是它自己那份复刻,
// **在这里加并发它照样绿**。钉子得跟着被钉的东西走。
export const syncAllUsers = (
  userIds: readonly string[],
  tallyOne: (userId: string) => Effect.Effect<Sweep.Tally> = (userId) =>
    Sweep.userTally(userId).pipe(Effect.provide(syncFor(userId))),
): Effect.Effect<SweepResult, never> =>
  Effect.forEach(userIds, tallyOne).pipe(
    Effect.map((tallies) => Sweep.sumTallies(userIds.length, tallies)),
  );
