import { Database } from "@folio/db";
import { Effect } from "effect";
import { injectManualSnapshots } from "@/lib/server/manual/store";
import { enrichBalances } from "@/lib/server/tokens/enrich";
import { type PortfolioScope, scopedMembership } from "./scope";

// 按账户视图的取数(账户页浏览器 + 详情侧栏用):每个账户 + 其最新快照的富化持仓。
// 与 `buildOverview`(按代币聚合)分开 —— 账户页是「按账户」的 home,需要每账户明细。
//
// 24h 盈亏不在这条链上(#493 票 3 拆开的;ADR 0050 之后它是独立读取,见 ./gain):
// 金额先亮,盈亏另包,前端拿到再贴回各行。
//
// **从 `listAccountHoldings` 里抽出来的,不是新逻辑。** 抽的理由是测试:这条链跨了账户、快照、
// manual 合成注入、富化四层,而「归档账户要不要在里面」正是跨层才看得出来的事(隔壁
// `scenarios.test.ts` 记着同一个教训:边界两侧各测一遍,挡不住跨边界传错值)。server fn 那层
// 拿不到测试上下文,抽出来之后 workers 池就能驱动真 D1 走一遍。
export const loadAccountHoldings = (scope: PortfolioScope) =>
  Effect.gen(function* () {
    // **整条链一个 effect,一次装配**(#394 T6):读账户 + 快照 → 注入 manual 合成项 → 逐账户富化。
    const db = yield* Database;
    const [member, everyAccount, snapshots] = yield* Effect.all(
      [scopedMembership(scope.portfolioId), db.accounts.list(), db.snapshots.latest()],
      { concurrency: 3 },
    );
    // **只当前组合的账户**(ADR 0047):以前整份回、账户页自己筛。判据与列表那条同一个
    // (归档无关 —— 这一页要显示归档区)。
    const allAccounts = everyAccount.filter((a) => member.has(a.id));
    // **归档账户也在里面**(ADR 0039):归档 = 封存,账户页要显示封存那一刻的持仓,而不是一具空壳。
    // 「计入总额」与「展示持仓」是两件事 —— 按代币聚合的那条路径仍然只算活跃账户。
    const active = allAccounts.filter((a) => a.archivedAt == null);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    // manual 不写快照(ADR 0018):注入合成当下项,manual 账户行的市值/持仓由账本现造。
    // **只喂活跃账户** —— 归档的 manual 账户要的是封存那一刻的数,注进去会被现算值盖掉,封存就成了假的。
    yield* injectManualSnapshots(active, byAccount);
    // **逐账户串行**(以前是 `Promise.all` 的隐式全并发)—— 每个账户一次批量读,
    // 账户数是个位数,而 D1 并不因为同时发十条而更快。
    const rows = yield* Effect.forEach(allAccounts, (account) =>
      Effect.gen(function* () {
        const latest = byAccount.get(account.id);
        const enriched = yield* enrichBalances(latest?.balances ?? []);
        return {
          account: { id: account.id, label: account.label },
          archivedAt: account.archivedAt,
          totalUsd: latest?.snapshot.totalUsd ?? 0,
          takenAt: latest?.snapshot.takenAt ?? null,
          // note 重设计(两级):① balance 级单个 note 随各 balance 透传(db 已把 snapshot_balances.note
          // safeParse 成 Note),现货行副行渲染 <NoteBadge>;② account 级 note(Note[],整钱包,BTC 未确认/
          // 收款/派生分布)是每账户一份,db 已 safeParse 成 Note[],这里随 row.note 带出 → 持仓区手风琴。
          note: latest?.note,
          balances: enriched.rows,
          pricesStale: enriched.pricesStale,
        };
      }),
    );
    // **刷价信号只按活跃账户算。** 富化会把行内代币记进「价格过期」集合,客户端据此发一次批量刷价。
    // 归档行纳进来之后不收窄的话:只有归档账户还持有的币会让每次进页白发一次请求 —— 而且刷完也不改
    // 它的显示值(封存值取自快照,不现推)。既浪费,又和「停更」是反的。
    const pricesStale = rows.some((r) => r.archivedAt == null && r.pricesStale);
    return { rows, pricesStale };
  });

// 按账户视图(账户页浏览器 + 详情侧栏用):每个账户 + 其最新快照的富化持仓,**含已归档账户**(ADR 0039)。
// handler 只是 auth 薄壳 —— 取数在上面的 loadAccountHoldings,这边才测得到(workers 池要驱动真 D1)。
export const handleListAccountHoldings = Effect.fn("listAccountHoldings")(function* (
  data: PortfolioScope = {},
) {
  return yield* loadAccountHoldings(data);
});
