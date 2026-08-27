import { Effect } from "effect";
import { makeAccountStore, makeGlobalAccountStore } from "./domains/accounts";
import { makeUserCacheStore } from "./domains/cache";
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

type EffectMethod = (...args: never[]) => Effect.Effect<unknown, unknown, unknown>;
type DomainStores = Record<string, Record<string, EffectMethod>>;

// **一处包装,七十个 op 全都有名字**(#504 T16)。键名即域名,与方法名拼成 `accounts.create`。
//
// T16 那张票原本判过「db 层不值得全链路命名」—— 前提是「得手写七十个 `Effect.fn`」。
// 聚合是这次重构才长出来的收口点,有了它成本就是下面这十几行,**一个方法都不用改**,
// 那个前提不成立了(票里已改)。
//
// 与桥那一层(`client.ts` 的 `db.query`)合起来是三层树:handler → domain op → D1。
// 中间这层答的是「哪个 domain 方法」—— 一个方法发多条查询时,只有它分得开。
//
// 约束里 `Effect.Effect<...>` 那个返回类型是有用的:哪天有人往域里加一个不返回 Effect 的
// 方法(同步 helper、返回 Stream 的),这里当场红。代价是报错点落在下面 `Database` 那一行,
// 而不是那个方法上 —— 见到这条红先回头看最近加的方法。
const tracedStores = <D extends DomainStores>(domains: D): D =>
  Object.fromEntries(
    Object.entries(domains).map(([domain, store]) => [
      domain,
      Object.fromEntries(
        Object.entries(store).map(([method, fn]) => [
          method,
          (...args: Parameters<EffectMethod>) =>
            fn(...args).pipe(Effect.withSpan(`${domain}.${method}`)),
        ]),
      ),
    ]),
  ) as D;

// **`@folio/db` 对外的那一张门票。** app 侧一次 `yield* Database` 拿到全部领域操作,
// 按领域取用:`db.tabPins.list()`、`db.accounts.list()`。以前是每个领域一个 Tag + 一个 layer
// 散装导出(八对),装配点为此 import 二十几行,handler 各自记住自己要哪几个 Tag。
//
// **它和 `client.ts` 的 `DbClient` 是两件事,别混**:
//   · `DbClient` —— D1 这一层的桥(`query` / `batch`),回调参数就是 drizzle 句柄。
//     **只在包内流通**(原则 #6):出包了包外就能拼任意查询,绕过全部包装。
//   · `Database` —— 本文件,包装好的领域 op 的聚合。**出包正是它的用途。**
//
// **不自己开连接。** `Database.Default` 的 `R` 通道声明 `DbClient`,谁装配谁给。这是硬性红线:
// 一次请求只能有一个 drizzle 句柄。如果这里自己 `dbClientLayer(env)`,那参考层那四个端口
// (它们也要 `DbClient`)就只能各自再开一条 —— 一次请求握着两三个句柄,今天只是浪费,
// 等这一层长出状态(span、慢查询计数)就是悄悄劈成几半的状态。
// 装配点(app 的 `lib/server/runtime.ts`)建一次 `dbClientLayer(env)`,一个 `Layer.provide`
// 分给所有人,Effect 的 layer memoisation 保证只建一次。
//
// **userId 在装配那一刻被吃掉**(ADR 0037):各领域建自己那一刻从 `CurrentUser` 读一次
// (ADR 0044),下面每个字段的方法签名里一个 user 参数都没有,拿错用户在编译期就发生不了。
//
// **挂的是各领域的 `make`,不是它们的 Tag**(#504 T5):`yield* AccountStore` 会把八个 Tag 顶到
// `Database.Default` 的 `R` 上,装配点就得先把八个 layer 合出来再 provide 一次 —— 聚合的意义
// 正是让装配点不必知道里头有几个领域。各领域那八个 class 现在只是过渡壳(app 还有调用点直接
// `yield*` 它们),T7–T12 搬完即删,留下的就是这里 yield 的这排 make。
export class Database extends Effect.Service<Database>()("db/Database", {
  effect: Effect.gen(function* () {
    return tracedStores({
      accounts: yield* makeAccountStore,
      manual: yield* makeManualStore,
      portfolios: yield* makePortfolioStore,
      settings: yield* makeSettingsStore,
      snapshots: yield* makeSnapshotStore,
      // 同步轮的状态(ADR 0048)。它落在 `user_cache` 上,但**不是**那片 KV 的一个用法 ——
      // 它的写入是带轮 id 条件的单语句,通用 `put(key, value)` 表达不了,漏网竞态会互相盖。
      syncRounds: yield* makeSyncRoundStore,
      tabPins: yield* makeTabPinStore,
      tags: yield* makeTagStore,
      transfer: yield* makeTransferStore,
      // **per-user 的 KV 缓存也在这张票上。** 它不是「领域」,是一片存储 —— 但取用方式与领域
      // 一样,而 app 真的有一处直接用它:DeFi 协议图(`logos/store.ts`)那份数据来自用户
      // 自己同步下来的余额 meta,没有上游、不出网,不属于参考层。以前它只能从参考层的装配里
      // 漏一个 `CacheStore` 端口出来给 app,那是「借道」;现在它就在 db 的门票上。
      cache: yield* makeUserCacheStore,
    });
  }),
}) {}

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
export class GlobalDatabase extends Effect.Service<GlobalDatabase>()("db/GlobalDatabase", {
  effect: Effect.gen(function* () {
    return tracedStores({
      refIndex: yield* makeGlobalRefIndexStore,
      accounts: yield* makeGlobalAccountStore,
    });
  }),
}) {}

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
    Effect.gen(function* () {
      return tracedStores({
        tokens: yield* makeUserTokenStore(namer),
        tokenPrices: yield* makeUserTokenPriceStore(namer),
        cache: yield* makeUserCacheStore,
      });
    }),
}) {}
