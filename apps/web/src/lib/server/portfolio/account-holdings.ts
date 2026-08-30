import { Database } from "@folio/db";
import { Effect } from "effect";
import {
  type AccountHoldingsData,
  GAIN_START_FLOOR_MS,
  GAIN_WINDOW_MS,
  toSnapshotView,
} from "@/lib/core/portfolio";
import { injectManualPrevSnapshots, injectManualSnapshots } from "@/lib/server/manual/store";
import { enrichBalances } from "@/lib/server/tokens/enrich";
import { type PortfolioScope, scopedMembership } from "./scope";

// 按账户视图的取数(账户页浏览器 + 详情侧栏用):每个账户 + 其最新快照的富化持仓。
// 与 `buildOverview`(按代币聚合)分开 —— 账户页是「按账户」的 home,需要每账户明细。
//
// **只发原料,不聚合、不重算、不算盈亏**(FOL-44 方向,与首页 `getPortfolioSnapshotData` 同路):
// 账户级现价重算 + 24h 盈亏都搬进浏览器 `accountRowsFromRaw`(query 的 `select`)。服务端这层只做
// 拿不到浏览器里去的事 —— 读行、注入 manual 合成项、cache-only 富化(带上现价 `unitPrice`)、备好
// 「24 小时前」那组起点料。以前这里在服务端取快照冻结 totalUsd/usdValue,于是账户页显示上次同步的
// 旧价、24h 恒 $0(现值=冻结=起点),与首页/单币的实时值打架 —— 换成发料 + 浏览器算就对齐了。
//
// **从 `listAccountHoldings` 里抽出来的,不是新逻辑。** 抽的理由是测试:这条链跨了账户、快照、
// manual 合成注入、富化四层,而「归档账户要不要在里面」正是跨层才看得出来的事(隔壁
// `scenarios.test.ts` 记着同一个教训:边界两侧各测一遍,挡不住跨边界传错值)。server fn 那层
// 拿不到测试上下文,抽出来之后 workers 池就能驱动真 D1 走一遍。
export const loadAccountHoldings = (scope: PortfolioScope) =>
  Effect.gen(function* () {
    // **整条链一个 effect,一次装配**(#394 T6):读账户 + 快照 → 注入 manual 合成项 → 逐账户富化。
    // 「当下」取一次,整条链共用(分段末点 / 容差判定 / 取历史的下界都按同一刻算)。
    const now = Date.now();
    const db = yield* Database;
    const [member, everyAccount, snapshots, settings] = yield* Effect.all(
      [
        scopedMembership(scope.portfolioId),
        db.accounts.list(),
        db.snapshots.latest(),
        db.settings.get(),
      ],
      { concurrency: 4 },
    );
    // 估值口径(self-first 默认):现价重算复用它,与首页 `deriveLiveAccountTotals` 同一个 mode。
    const mode = settings.valuationMode;
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
          // 冻结快照总额,原样发下去 —— 活跃行的现价重算在浏览器 `accountRowsFromRaw` 里做
          //(归档行封存,浏览器原样用这个值,ADR 0039)。
          totalUsd: latest?.snapshot.totalUsd ?? 0,
          takenAt: latest?.snapshot.takenAt ?? null,
          // note 重设计(两级):① balance 级单个 note 随各 balance 透传(db 已把 snapshot_balances.note
          // safeParse 成 Note),现货行副行渲染 <NoteBadge>;② account 级 note(Note[],整钱包,BTC 未确认/
          // 收款/派生分布)是每账户一份,db 已 safeParse 成 Note[],这里随 row.note 带出 → 持仓区手风琴。
          note: latest?.note,
          // 富化行带着现价 `unitPrice`(cache-only),浏览器据此逐行 `liveValue` 重算 —— 原料齐了。
          balances: enriched.rows,
          pricesStale: enriched.pricesStale,
        };
      }),
    );
    // **刷价信号只按活跃账户算。** 富化会把行内代币记进「价格过期」集合,客户端据此发一次批量刷价。
    // 归档行纳进来之后不收窄的话:只有归档账户还持有的币会让每次进页白发一次请求 —— 而且刷完也不改
    // 它的显示值(封存值取自快照,不现推)。既浪费,又和「停更」是反的。
    const pricesStale = rows.some((r) => r.archivedAt == null && r.pricesStale);

    // 「24 小时前」那一组起点料(ADR 0050,两端相减):每账户 [now-7d, now-24h] 窗口内最近一张
    //(`asOf`)+ manual 折算注入。**这里只备料、不相减** —— 两端相减 / 逐行摊分在浏览器
    // `accountRowsFromRaw` → `attachAccountHoldingGains` 里,与首页同路。起点端只是一次点查
    //(不捞整个窗口的余额历史),便宜到随持仓一起发。
    const start = now - GAIN_WINDOW_MS;
    const prevRaw = yield* db.snapshots.asOf(start, now - GAIN_START_FLOOR_MS);
    const memberSet = new Set(allAccounts.map((a) => a.id));
    const prevByAccount = new Map(
      prevRaw
        .filter((s) => memberSet.has(s.snapshot.accountId))
        .map((s) => [s.snapshot.accountId, s]),
    );
    yield* injectManualPrevSnapshots(active, prevByAccount, start, now);
    // Map → entries 过线,浏览器 `accountRowsFromRaw` 里重建(与首页 `PortfolioSnapshotData` 同法)。
    const prevSnapshots = [...prevByAccount].map(
      ([id, s]): [string, ReturnType<typeof toSnapshotView>] => [id, toSnapshotView(s)],
    );
    return { rows, prevSnapshots, mode, pricesStale } satisfies AccountHoldingsData;
  });

// 按账户视图(账户页浏览器 + 详情侧栏用):每个账户 + 其最新快照的富化持仓,**含已归档账户**(ADR 0039)。
// handler 只是 auth 薄壳 —— 取数在上面的 loadAccountHoldings,这边才测得到(workers 池要驱动真 D1)。
export const handleListAccountHoldings = Effect.fn("listAccountHoldings")(function* (
  data: PortfolioScope = {},
) {
  return yield* loadAccountHoldings(data);
});
