import { Effect } from "effect";
import { makeAccountStore } from "./domains/accounts";
import { makeManualStore } from "./domains/manual";
import { makePortfolioStore } from "./domains/portfolios";
import { makeSettingsStore } from "./domains/settings";
import { makeSnapshotStore } from "./domains/snapshots";
import { makeTabPinStore } from "./domains/tab-pins";
import { makeTagStore } from "./domains/tags";
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
      tabPins: yield* makeTabPinStore,
      tags: yield* makeTagStore,
      transfer: yield* makeTransferStore,
    });
  }),
}) {}
