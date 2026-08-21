import { AccountStore, SnapshotStore } from "@folio/db";
import { Effect } from "effect";
import {
  buildGainLines,
  computeGain24h,
  GAIN_BASIS_TOLERANCE_MS,
  GAIN_WINDOW_MS,
  type Gain,
  type GainCurrentRow,
} from "./gain-24h";
import { injectManualSnapshots, loadManualGainHistory } from "../internal/manual";
import { enrichBalances } from "../tokens/enrich";

type WithOptionalGain<R extends { balances: readonly unknown[] }> = Omit<R, "balances"> & {
  gain24h?: Gain | null;
  balances: Array<R["balances"][number] & { gain24h?: Gain | null }>;
};

// 按账户视图的取数(账户页浏览器 + 详情侧栏用):每个账户 + 其最新快照的富化持仓。
// 与 `buildOverview`(按代币聚合)分开 —— 账户页是「按账户」的 home,需要每账户明细。
//
// **从 `listAccountHoldings` 里抽出来的,不是新逻辑。** 抽的理由是测试:这条链跨了账户、快照、
// manual 合成注入、富化四层,而「归档账户要不要在里面」正是跨层才看得出来的事(隔壁
// `scenarios.test.ts` 记着同一个教训:边界两侧各测一遍,挡不住跨边界传错值)。server fn 那层
// 拿不到测试上下文,抽出来之后 workers 池就能驱动真 D1 走一遍。
export const loadAccountHoldings = (withGain = false) =>
  Effect.gen(function* () {
    // **整条链一个 effect,一次装配**(#394 T6):读账户 + 快照 → 注入 manual 合成项 → 逐账户富化。
    // 「当下」取一次,整条链共用(分段末点 / 容差判定 / 取历史的下界都按同一刻算)。
    const now = Date.now();
    const [allAccounts, snapshots] = yield* Effect.all(
      [
        Effect.flatMap(AccountStore, (s) => s.list()),
        Effect.flatMap(SnapshotStore, (s) => s.latest()),
      ],
      { concurrency: 2 },
    );
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
    // #493 票 3:金额先亮,盈亏另包。默认这条路不算 24h —— 历史窗口那一读比富化当下贵。
    if (!withGain) {
      return { rows: rows as WithOptionalGain<(typeof rows)[number]>[], pricesStale };
    }

    // 账户行的 24h 盈亏(ADR 0040):**线按账户攒**,而不是按币 —— 同一个装配、换个分组键。
    // manual 不写快照,原料另走账本(#447 第 3 片)。
    // 窗口起点再往前留一个容差,否则基准快照恰好落在窗口外时整条线判「算不出」—— 而它明明就在库里。
    const [gainHistory, manualGain] = yield* Effect.all(
      [
        Effect.flatMap(SnapshotStore, (s) =>
          s.listBalanceHistory(now - GAIN_WINDOW_MS - GAIN_BASIS_TOLERANCE_MS),
        ),
        loadManualGainHistory(active, now, now - GAIN_WINDOW_MS),
      ],
      { concurrency: 2 },
    );
    const current: GainCurrentRow[] = rows.flatMap((r) =>
      r.balances.map((b) => ({
        accountId: r.account.id,
        tokenId: b.tokenId ?? null,
        amount: b.amount,
        value: b.usdValue,
      })),
    );
    const history = [...gainHistory, ...manualGain];
    const gainLines = buildGainLines(history, current, now, (r) => r.accountId);
    // 抽屉里的**现货行**要的是每个币各自的数,所以同一套原料再按 (账户 × 币) 攒一次。
    // 一个账户里同一个币可能落成几行(多链 / 多 Wallet),而线是按币的一条 —— 所以整体金额按各行
    // 的市值占比**摊回去**:各行加起来仍等于那个币的总盈亏,而百分比是整条线的(同一个币同一段
    // 时间的收益率本就一样,不该因为分了几条链而不同)。
    const perToken = buildGainLines(history, current, now, (r) => `${r.accountId} ${r.tokenId}`);
    const tokenTotals = new Map<string, number>();
    for (const c of current) {
      if (c.tokenId == null) continue;
      const k = `${c.accountId} ${c.tokenId}`;
      tokenTotals.set(k, (tokenTotals.get(k) ?? 0) + c.value);
    }
    const gainByAccount = new Map(
      rows.map((r) => [
        r.account.id,
        // **归档账户不给这个数**(ADR 0039):市值冻在封存那一刻,「今天涨了多少」对一个停住的
        // 数字无从谈起。那不是「算不出」,是这个位置压根不该有 —— 界面据此整行省略,而不是画 `—`。
        r.archivedAt != null ? undefined : computeGain24h(gainLines.get(r.account.id) ?? [], now),
      ]),
    );

    return {
      rows: rows.map(
        (r): WithOptionalGain<(typeof rows)[number]> => ({
          ...r,
          gain24h: gainByAccount.get(r.account.id),
          // **每一支都带上 `gain24h` 这个键**(哪怕是 undefined)—— 只在部分分支加字段的话,
          // 推断出来的是个联合类型,调用方(和测试)读 `.gain24h` 会在「没有这个属性」的那一支上编译不过。
          balances: r.balances.map((b): typeof b & { gain24h?: Gain | null } => {
            // 归档 = 封存:这个位置不该有这个数(ADR 0039)→ undefined,界面整行省略而不是画 `—`。
            if (b.tokenId == null || r.archivedAt != null) return { ...b, gain24h: undefined };
            const k = `${r.account.id} ${b.tokenId}`;
            const gain = computeGain24h(perToken.get(k) ?? [], now);
            if (gain == null) return { ...b, gain24h: null };
            // 一个币散在多条链 = 抽屉里的多行,而线是按 (账户 × 币) 的一条。按各行市值占比摊分,
            // 于是逐行显示加起来仍等于这个币真正赚的;百分比是整条线的(同币同段的收益率本就一样)。
            const total = tokenTotals.get(k) ?? 0;
            const share = total === 0 ? 0 : b.usdValue / total;
            // 段也跟着摊:金额按占比缩,百分比不动(同一个币同一段的收益率与它分在几条链无关)。
            return {
              ...b,
              gain24h: {
                amount: gain.amount * share,
                pct: gain.pct,
                segments: gain.segments.map((seg) => ({
                  ...seg,
                  openValue: seg.openValue * share,
                  gain: seg.gain * share,
                })),
              },
            };
          }),
        }),
      ),
      pricesStale,
    };
  });
