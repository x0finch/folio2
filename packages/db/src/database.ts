import { Context, Effect } from "effect";
import { DbClient } from "./client";
import { CurrentUser } from "./current-user";
import { makeAccountStore, makeGlobalAccountStore } from "./domains/accounts";
import { makeUserCacheStore } from "./domains/cache";
import { makeDataVersionStore } from "./domains/data-version";
import { makeGlobalRefIndexStore } from "./domains/global-ref-index";
import { makeManualStore } from "./domains/manual";
import { makePortfolioStore } from "./domains/portfolios";
import { makeSettingsStore } from "./domains/settings";
import { makeSnapshotStore } from "./domains/snapshots";
import { makeSyncRoundStore } from "./domains/sync-rounds";
import { makeTabPinStore } from "./domains/tab-pins";
import { makeTagStore } from "./domains/tags";
import { makeUserTokenPriceStore } from "./domains/token-prices";
import { makeUserTokenStore } from "./domains/tokens";
import { makeTransferStore } from "./domains/transfer";

/**
 * **一次请求要给 db 的两样**:这次是谁的(`CurrentUser`)+ 那一个 D1 句柄(`DbClient`)。
 *
 * per-user 的 op 的 `R` 就是它(ADR 0054):服务图每个 isolate 建一次,这两样每个 op 跑的那一刻
 * 从 context 里取。包外拿不到这两个 Tag 的值 —— 只能经 `provideCurrentUser` / `provideDbClient`
 * 两个组合子给,而 app 里给的地方只有装配点。
 */
export type DbRequest = CurrentUser | DbClient;

type EffectMethod = (...args: never[]) => Effect.Effect<unknown, unknown, unknown>;
type Methods = Record<string, EffectMethod>;

// 一个领域「绑定到一个连接(+ 一个用户)之后」的样子 → 门票上那一格的样子:参数与成败不变,
// `R` 多出 `R`。
type PerCall<S, R> = {
  [K in keyof S]: S[K] extends (...args: infer P) => Effect.Effect<infer A, infer E, infer R0>
    ? (...args: P) => Effect.Effect<A, E, R0 | R>
    : never;
};

/**
 * **全包唯一一处读 `CurrentUser` / `DbClient` 的地方**(ADR 0054)。
 *
 * 每个领域写成一个纯函数 `(client, userId) => 方法表`:给它一个连接、一个用户,它就是那个用户的
 * 那一组 op —— 与以前「建服务那一刻读一次、绑进闭包」是同一份代码,只是不再由 `Effect.gen`
 * 从 context 里抓。这里把它们挂成门票:门票上的每个方法在**被调用、真跑起来的那一刻**从 fiber 的
 * context 里取那两样,绑一次,调那一个方法。于是门票本身不含任何请求的东西,可以每个 isolate
 * 只建一份;两个请求(两个用户)同时拿着它,各跑各的 context,互相看不见。
 *
 * **为什么每次调用都绑一次而不缓存**:绑定只是十来个闭包(领域函数里没有任何 I/O —— 见下面那个
 * 占位),而缓存得有地方放 —— 按连接对象记的表就是模块级可变状态,正是这次不许加的东西。
 *
 * **方法名怎么来**:建门票时拿一个**占位**绑一次,只读它有哪些键。领域函数是纯的,这一次什么都
 * 不跑;万一哪天有人在领域函数的顶层(而不是方法里)碰了连接,占位 `die` 出来的 effect 也不会被
 * 执行 —— 真跑起来的每一次都是上面那条「调用时绑定」的路。
 *
 * **span 顺带挂在这里**(#504 T16):键名即域名,与方法名拼成 `accounts.create`,七十个 op 一处包上。
 * 与桥那一层(`client.ts` 的 `db.query`)合起来是三层树:handler → domain op → D1。
 * `captureStackTrace: false`:`Effect.withSpan` 默认每调用一次就 `new Error()` 抓一份调用点
 * (不论 tracer 开没开,Effect 3.22 的 `addSpanStackTrace` 不看开关),而这里的调用点永远是
 * 同一行 —— 抓了也没有信息。
 */
const bindPerCall =
  <Args extends readonly unknown[], R>(read: Effect.Effect<Args, never, R>, placeholder: Args) =>
  <D extends Record<string, (...args: Args) => Methods>>(
    domains: D,
  ): { [K in keyof D]: PerCall<ReturnType<D[K]>, R> } =>
    Object.fromEntries(
      Object.entries(domains).map(([domain, bind]) => [
        domain,
        Object.fromEntries(
          Object.keys(bind(...placeholder)).map((method) => [
            method,
            (...args: never[]) =>
              Effect.flatMap(read, (ctx) => bind(...ctx)[method](...args)).pipe(
                Effect.withSpan(`${domain}.${method}`, { captureStackTrace: false }),
              ),
          ]),
        ),
      ]),
    ) as { [K in keyof D]: PerCall<ReturnType<D[K]>, R> };

// 占位连接:只给上面那一次「读有哪些键」用。它的两个方法**从不该被跑到**,真跑到了就是 bug。
const unbound = DbClient.make({
  query: () => Effect.die(new Error("db: an op ran against the placeholder client")),
  batch: () => Effect.die(new Error("db: an op ran against the placeholder client")),
});

// per-user 的那几张门票用这个:连接 + 用户,两样都在 op 跑的那一刻取。
const perUser = bindPerCall(
  Effect.contextWith(
    (ctx: Context.Context<DbRequest>) =>
      [Context.get(ctx, DbClient), Context.get(ctx, CurrentUser)] as const,
  ),
  [unbound, ""] as const,
);

// 没有「谁的」这回事的那张用这个:**只取连接** —— 于是它的 `R` 里压根没有 `CurrentUser`。
const ownerless = bindPerCall(
  Effect.map(DbClient, (client) => [client] as const),
  [unbound] as const,
);

// **`@folio/db` 对外的那一张门票。** app 侧一次 `yield* Database` 拿到全部领域操作,
// 按领域取用:`db.tabPins.list()`、`db.accounts.list()`。以前是每个领域一个 Tag + 一个 layer
// 散装导出(八对),装配点为此 import 二十几行,handler 各自记住自己要哪几个 Tag。
//
// **它和 `client.ts` 的 `DbClient` 是两件事,别混**:
//   · `DbClient` —— D1 这一层的桥(`query` / `batch`),回调参数就是 drizzle 句柄。
//     **只在包内流通**(原则 #6):出包了包外就能拼任意查询,绕过全部包装。
//   · `Database` —— 本文件,包装好的领域 op 的聚合。**出包正是它的用途。**
//
// **不自己开连接,也不握着连接。** 门票上的 op 在跑的那一刻从 context 里取 `DbClient`(上面的
// `bindPerCall`),谁装配谁给。红线仍是**一次请求一个 drizzle 句柄**(ADR 0045 §3):装配点
// (app 的 `lib/server/runtime.ts`)一次请求 `provideDbClient(env)` 一次,这次请求里的每一个 op ——
// 这张票上的、参考层那张票上的 —— 读到的都是那同一个值。
//
// **门票本身每个 isolate 建一次**(ADR 0054):它里面没有连接、没有用户,只有「怎么绑」。
// userId 同样在 op 跑的那一刻取;下面每个字段的方法签名里一个 user 参数都没有(ADR 0037),
// 而 `R` 里的 `CurrentUser` 保证没给 user 的 effect 编译不过(ADR 0044 选 Tag 不选 Reference 的理由)。
//
// **挂的是各领域的绑定函数,不是它们的 Tag**(#504 T5):聚合的意义正是让装配点不必知道里头有几个
// 领域。
const databaseOps = () =>
  perUser({
    accounts: makeAccountStore,
    // 数据版本号(FOL-94):只读;抬它的是触发器(见 `domains/data-version.ts`)。
    dataVersion: makeDataVersionStore,
    manual: makeManualStore,
    portfolios: makePortfolioStore,
    settings: makeSettingsStore,
    snapshots: makeSnapshotStore,
    // 同步轮的状态(ADR 0048)。它落在 `user_cache` 上,但**不是**那片 KV 的一个用法 ——
    // 它的写入是带轮 id 条件的单语句,通用 `put(key, value)` 表达不了,漏网竞态会互相盖。
    syncRounds: makeSyncRoundStore,
    tabPins: makeTabPinStore,
    tags: makeTagStore,
    transfer: makeTransferStore,
    // **per-user 的 KV 缓存也在这张票上。** 它不是「领域」,是一片存储 —— 但取用方式与领域
    // 一样,而 app 真的有一处直接用它:DeFi 协议图(`logos/store.ts`)那份数据来自用户
    // 自己同步下来的余额 meta,没有上游、不出网,不属于参考层。以前它只能从参考层的装配里
    // 漏一个 `CacheStore` 端口出来给 app,那是「借道」;现在它就在 db 的门票上。
    cache: makeUserCacheStore,
  });

export class Database extends Effect.Service<Database>()("db/Database", { sync: databaseOps }) {}

// **第二张门票:没有「谁的」这回事的那些 op。**
//
// 判据就是 CLAUDE.md 原则 #6 那一条 —— **表里有没有「谁的」这回事**。两个成员各自都不是新东西,
// 它们只是终于住到了一起:
//   · `refIndex`  —— `global_token_ref_index`(ADR 0022):上游的公开知识,可整表重建
//   · `accounts`  —— cron 扫「有哪些用户」那一条(它问的正是「有哪些用户」,所以不可能 per-user)
//
// **为什么不并进 `Database`**:那张是 per-user 的,建它得先有一个 userId。cron 两条路都没有 ——
// 逼它编一个假的,就等于把「没有 userId 就构造不出 per-user 的东西」这条保证拆了。
//
// **为什么不各自裸着出去**:它们以前就是裸着的,而且是两种形状 —— 一张 layer 和一个裸 Effect,
// 于是 app 那边还得配一个 `withDbClient` 专门喂后者。判据同一条,出口却各长各的;
// 收成一张之后,下一个不带 user 的 op 不必再决定一次它长什么样。
//
// `R` 里只有 `DbClient`,**没有 `CurrentUser`** —— 这就是它与 `Database` 的全部区别,
// 也是类型上「这里够不到任何用户数据」的写法。
const globalOps = () =>
  ownerless({
    refIndex: makeGlobalRefIndexStore,
    accounts: makeGlobalAccountStore,
  });

export class GlobalDatabase extends Effect.Service<GlobalDatabase>()("db/GlobalDatabase", {
  sync: globalOps,
}) {}

/**
 * **上面两张门票,不经 Layer、直接造成一份 context**(FOL-83 第二轮,ADR 0054 补记)。
 *
 * 与 `Database.Default` / `GlobalDatabase.Default` 是同一份构造(同一个 `databaseOps` / `globalOps`),
 * 只是不走 Layer 的构建机器:冷 isolate 上 `ManagedRuntime.make(Layer.mergeAll(这两张 + 日志))`
 * 本机实测约 20ms CPU,其中大半是 Layer 自己(memo 表、scope、并行合并时 fork 的 fiber),
 * 两张门票本身是纯闭包、零 I/O。app 的 cron / 队列入口只要这两张时就用这份手搭一个 `Runtime`。
 */
export const databaseTickets = (): Context.Context<Database | GlobalDatabase> =>
  Context.make(Database, Database.make(databaseOps())).pipe(
    Context.add(GlobalDatabase, GlobalDatabase.make(globalOps())),
  );

// **第三张门票:参考层要的那几片。**
//
// 为什么不并进 `Database` —— 那是 handler 拿的票。`tokens` / `tokenPrices` 一挂上去,任何
// handler 就都能直接改代币行和价格行,绕过参考层的 mint 与 SWR 编排(#504 T17 收窄的就是这个,
// `user-services-surface.test.ts` 钉着)。所以它们只在这张票上,而这张票只给 `@folio/oracle`。
//
// **`namer` 是参数,不是从服务里 yield 的。** 凡是要按命名者点查 `token_refs` 的读、以及历史
// 日价那条全局键,都要当前上游的 id;db 层不预设任何厂商(表名列名零 vendor 字样,#199)。
// 从参考层的 `Namer` 端口里 yield 会让 db 反过来消费 oracle 的一个服务 —— 而装配点手里
// 本来就握着这个常量。
//
// `cache` 在这里和 `Database` 上各有一份。**那不是状态被劈成两半** —— 这个 store 是无状态的
// (只是几个闭包 + 同一个 `DbClient`),两份对象读写的是同一张表、同一批行。以前靠
// `provideMerge` 把参考层内部那一个透出去给 app 共用,反倒是更绕的写法。
export class DatabaseForOracle extends Effect.Service<DatabaseForOracle>()("db/DatabaseForOracle", {
  effect: (namer: string) =>
    Effect.sync(() =>
      perUser({
        tokens: makeUserTokenStore(namer),
        tokenPrices: makeUserTokenPriceStore(namer),
        cache: makeUserCacheStore,
      }),
    ),
}) {}

// 参考层那几片的契约 —— **就是门票上那一格的类型**(从实现推导,不另抄一份签名)。出包是因为
// `@folio/oracle` 的几片把 store 当参数往下传,要一个能写在签名里的名字。
export type TokenStore = DatabaseForOracle["tokens"];
export type TokenPriceStore = DatabaseForOracle["tokenPrices"];
export type CacheStore = DatabaseForOracle["cache"];
export type GlobalRefIndexStore = GlobalDatabase["refIndex"];
