import { Database } from "@folio/db";
import { Effect } from "effect";
import { accountIdsInView, accountsInView } from "@/lib/core/accounts-in-view";
import type { PortfolioHistoryRaw } from "@/lib/core/history";
import { isManual } from "@/lib/core/manual";
import { loadManualHistoryRows } from "@/lib/server/manual/store";
import { resolveScope } from "./scope";

// 组合净值历史:**只发原料,不算曲线**(FOL-38 / ADR 0049)。
//
// 发出去的是「每账户、各自时刻」的快照总额行 + 归档时刻表;阶梯重建、归档截断、降采样全部在
// 浏览器里跑(`lib/core/history.ts`)。理由是 10 毫秒的 CPU 预算:原料本来就小(每账户每次同步
// 一行,实测存量账号 928 行 ≈ 98 KB、gzip 后 16 KB),而算完的曲线点数与原料行数几乎一样多 ——
// 花 CPU 换不来更小的响应。
//
// **「当下点」不在这里算了。** 它是与主页同源的实时总价,而那个数总览接口已经算过一遍;
// 为了曲线再算一遍要把每个账户最新快照的全部余额读出来 + 过一遍报价(`snapshots.latest()` +
// `deriveLiveAccountTotals`),正是这条读接口里最贵的一段。这里只说清楚**末点该算哪些账户**
// (`liveAccountIds`),前端拿总览按账户那张表把它们加起来 —— 同一个数,少算一遍。
// 发的是账户名单而不是让前端直接用总览那个总额:总览可以是按自定义 Tab 收窄过的,而曲线从不
// 收窄,名单让前端认得出「这份总览不是这条曲线的口径」(见 `toPortfolioCurve`)。
//
// 留在服务端的只有两件事,都不是聚合:① 按选中 Portfolio **筛行**(ADR 0047 作用域在服务端定,
// 别人组合的行不该出门);② 手记账户的日网格 **compute-on-read**(ADR 0018/0019)—— 它产的
// 就是原料点本身,而它的原料(账本活动 + 历史日价)比产出大得多,搬到前端只会更贵。
export const handleGetPortfolioHistory = Effect.fn("getPortfolioHistory")(function* (data: {
  portfolioId?: string;
}) {
  const db = yield* Database;
  const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
  const [rows, allAccounts, memberships] = yield* Effect.all(
    [db.snapshots.listTotals(), db.accounts.list(), db.portfolios.listMemberships()],
    { concurrency: 3 },
  );
  // 曲线追溯性地只算选中 Portfolio 的当前成员(ADR 0033):memberSet **含已归档账户** ——
  // 过去点按它 scope,保留归档成员在封存之前的历史贡献。把账户移进/移出 Portfolio,这条曲线
  // 整条重算(直觉:这钱在这个视图里从来算/不算)。
  // 自定义 Tab(ADR 0034 UI 微调):曲线**不按 pin 收窄** —— pin 只过滤该 Tab 的列表内容,
  // hero 总额/曲线保持选中 Portfolio 口径(用户明确:自定义 Tab 不改 hero)。故历史入参不带 pin。
  const memberSet = accountIdsInView(
    allAccounts.map((a) => a.id),
    memberships,
    selectedId,
    defaultId,
  );
  const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));

  // manual 历史改由账本 compute-on-read 供货(ADR 0018):防御式排除任何遗留 manual snapshot 行(正常为空),
  // 再拼上账本现算的 manual (takenAt, totalUsd) 行 —— 同一种行,前端不需要区分,不双算。
  const manualIds = new Set(memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id));
  const snapRows = rows.filter((r) => !manualIds.has(r.accountId) && memberSet.has(r.accountId));
  // manual 走日网格 compute-on-read(ADR 0019),末点 τ=now → 与前端拿总览总额覆写的那一刻对齐。
  const manualRows = yield* loadManualHistoryRows(memberAccounts, Date.now());
  const archivedAt = memberAccounts.flatMap((a) =>
    a.archivedAt == null ? [] : [[a.id, a.archivedAt] as [string, number]],
  );
  // 末点只算活跃成员 —— 与总览那份账户集(`accountsInView`)逐字同源,归档的那些只贡献过去点。
  const liveAccountIds = accountsInView(allAccounts, memberships, selectedId, defaultId).map(
    (a) => a.id,
  );
  // `satisfies`:接口发的原料与前端那个装配函数吃的原料是同一个形状,这一行让接缝在编译期对齐。
  return {
    rows: [...snapRows, ...manualRows],
    archivedAt,
    liveAccountIds,
  } satisfies PortfolioHistoryRaw;
});
