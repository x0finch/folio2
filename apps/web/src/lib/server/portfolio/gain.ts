import { type AccountSafe, Database } from "@folio/db";
import { Effect } from "effect";
import { defiGainKey } from "@/lib/core/account-view";
import { accountsInView, accountsMatchingPin, toTabPin } from "@/lib/core/accounts-in-view";
import { isFungible, viewKind } from "@/lib/core/balance-kind";
import { isManual } from "@/lib/core/manual";
import { injectManualSnapshots, loadManualStartSnapshots } from "@/lib/server/manual/store";
import { NO_TOKEN_KEY_PREFIX } from "./aggregate";
import {
  assembleGainStart,
  endpointGain,
  GAIN_WINDOW_MS,
  type Gain,
  type StartSnapshot,
  tokenLineKey,
} from "./gain-24h";
import type { OverviewView } from "./overview-model";
import { readStoredOverview } from "./precompute";
import { type PortfolioScope, resolveScope, scopedMembership } from "./scope";

// 24h 盈亏的两条读接口(ADR 0050,取代 ADR 0040 的分段法)。
//
// **两端相减,每次请求现算**:现在的值 − 24 小时前的值。「现在」那一端拿现成的
// (组合级 = 存量总览,账户级 = 最新快照 + 手记现造 —— 都是各自页面正端着的数);
// 「24 小时前」那一端是**一次点查**(`snapshots.asOf`:每账户 ≤ 起点的最近一张)。
// 两个点查加几条名单查询,查询数与持币数无关 —— 小到不再需要预计算、缓存键、失效、
// pending 轮询,ADR 0049 的 10ms 预算装得下。
//
// **充提计入当天盈亏,是裁定的设计,不是 bug**:充值 10 万,今天就显示 +10 万。
// 不再有任何「剔除资金进出」的聪明。

// DeFi 协议行那个数比 `Gain` 多一个 `basis`(起点净值,= 百分比的分母):跨账户合并时
// 百分比要重算(Σ金额 ÷ Σ起点),没有分母就只能拿各账户百分比瞎平均。
// **从视图类型上取,不在这里手抄一份** —— 这两处必须是同一个形状(core/account-view 是它的家)。
type DefiGain = NonNullable<OverviewView["sections"][number]["defi"][number]["gain24h"]>;

/** 组合级 24h 盈亏的返回形状。 */
export interface PortfolioGain24h {
  portfolio: Gain | null;
  holdings: Record<string, Gain | null>;
  defi: Record<string, DefiGain | null>;
}

// 空态 = 「什么都算不出」。**每次现造一个新对象**:调用方拿到的是响应体,共用一份常量的话,
// 任何一处顺手往上挂个字段都会污染下一次请求。
const emptyPortfolioGain = (): PortfolioGain24h => ({ portfolio: null, holdings: {}, defi: {} });

/**
 * 「24 小时前」那一端:每个在册账户 ≤ 起点的最近一张快照(一次点查),manual 账户由账本折算
 * (它不写快照,ADR 0018;归档时封的那张快照也因此不该再当它的起点,按 connector 挡掉)。
 */
const loadGainStart = (accounts: readonly AccountSafe[], now: number, start: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const synced = new Set(accounts.filter((a) => !isManual(a.connectorId)).map((a) => a.id));
    const [snaps, manual] = yield* Effect.all(
      [db.snapshots.asOf(start), loadManualStartSnapshots([...accounts], now, start)],
      { concurrency: 2 },
    );
    const fromSnaps: StartSnapshot[] = snaps
      .filter((s) => synced.has(s.snapshot.accountId))
      .map((s) => ({
        accountId: s.snapshot.accountId,
        takenAt: s.snapshot.takenAt,
        totalUsd: s.snapshot.totalUsd,
        balances: s.balances,
      }));
    return assembleGainStart([...fromSnaps, ...manual]);
  });

/**
 * 组合级 24h 盈亏:组合总额 + 每个持仓行 + 每个 DeFi 协议行,全是同一个减法。
 *
 * 「现在」那一端读**存量总览**(与 hero 上那个总额同一份数,新鲜与否都端 —— 见
 * `readStoredOverview`);「24 小时前」那一端一次点查。从没算过总览的组合(缓存整个冷)
 * → 空态,总览补算落地后下一次取数自然就有了。
 */
export const handleGetPortfolioGain24h = Effect.fn("getPortfolioGain24h")(function* (
  data: PortfolioScope,
) {
  const now = Date.now();
  const startAt = now - GAIN_WINDOW_MS;
  const db = yield* Database;
  const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
  const pin = toTabPin(data.pin);
  const view = yield* readStoredOverview(selectedId, pin);
  if (!view) return emptyPortfolioGain();

  // 起点按**当前**的账户集取(与总览同一个口径:组合内、pin 收窄、排除归档)。
  const [allAccounts, memberships] = yield* Effect.all(
    [db.accounts.list(), db.portfolios.listMemberships()],
    { concurrency: 2 },
  );
  const tagLinks = pin?.kind === "tag" ? yield* db.tags.listAccountLinks() : [];
  const accounts = accountsMatchingPin(
    accountsInView(allAccounts, memberships, selectedId, defaultId),
    pin,
    tagLinks,
  );
  const start = yield* loadGainStart(accounts, now, startAt);

  // 一个账户都没有 24 小时前的观测 → 整份全 `null`(界面 `—`),绝不拿首张快照冒充基准。
  // 有观测之后,某个币 / 协议在起点查不到就是 0 —— 今天新进来的仓整个算今天的盈亏(裁定)。
  const tokenStart = (key: string): number | null => {
    if (start.total == null) return null;
    // 无 token_id 的旧行(v2 导入)各自成行,键不是币的身份 —— 起点对不上号,只能「算不出」,
    // 不能按 0 算:按 0 会让这份存量每天都显示成「今天赚的」。
    if (key.startsWith(NO_TOKEN_KEY_PREFIX)) return null;
    return start.tokens.get(key) ?? 0;
  };
  const holdings: Record<string, Gain | null> = {};
  for (const h of view.holdings) holdings[h.key] = endpointGain(tokenStart(h.key), h.totalValue);

  const defi: Record<string, DefiGain | null> = {};
  for (const s of view.sections) {
    for (const g of s.defi) {
      const key = defiGainKey(s.account.id, g.protocol);
      const current = g.rows.reduce((sum, r) => sum + r.usdValue, 0);
      const basis = start.total == null ? null : (start.defi.get(key) ?? 0);
      const gain = endpointGain(basis, current);
      defi[key] = gain == null ? null : { ...gain, basis: basis as number };
    }
  }

  return { portfolio: endpointGain(start.total, view.totalUsd), holdings, defi };
});

/**
 * 账户级 24h 盈亏:账户行 + 抽屉里的现货行,同一个减法。
 *
 * 「现在」那一端 = 最新快照(manual 现造注入)—— 与账户页正显示的市值同源
 * (`loadAccountHoldings` 的 `totalUsd` 就是它);不富化:盈亏不需要名字和 logo。
 */
export const handleGetAccountGain24h = Effect.fn("getAccountGain24h")(function* (
  data: PortfolioScope = {},
) {
  const now = Date.now();
  const startAt = now - GAIN_WINDOW_MS;
  const db = yield* Database;
  const [member, everyAccount, snapshots] = yield* Effect.all(
    [scopedMembership(data.portfolioId), db.accounts.list(), db.snapshots.latest()],
    { concurrency: 3 },
  );
  // 归档账户两级都不出现(ADR 0039):市值冻在封存那一刻,「今天涨了多少」无从谈起。
  const active = everyAccount.filter((a) => member.has(a.id) && a.archivedAt == null);
  const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
  yield* injectManualSnapshots(active, byAccount);
  const start = yield* loadGainStart(active, now, startAt);

  const accounts: Record<string, Gain | null> = {};
  const balances: Record<string, Gain | null> = {};
  for (const a of active) {
    const latest = byAccount.get(a.id);
    // 账户行:整账户净值的两端相减(defi / perp 的价值变化都在里面)。
    accounts[a.id] = endpointGain(start.accounts.get(a.id) ?? null, latest?.snapshot.totalUsd ?? 0);

    // 现货行:线按 (账户 × 币),一个币散在多条链 = 抽屉里的多行,金额按各行市值占比摊回去 ——
    // 逐行显示加起来仍等于这个币的两端之差;百分比是整条线的(同币同段的涨跌与分几条链无关)。
    const rows = (latest?.balances ?? []).filter(
      (b) => b.tokenId != null && isFungible(viewKind(b)),
    );
    const lineCurrent = new Map<string, number>();
    for (const b of rows) {
      const k = tokenLineKey(a.id, b.tokenId as string);
      lineCurrent.set(k, (lineCurrent.get(k) ?? 0) + b.usdValue);
    }
    for (const b of rows) {
      const k = tokenLineKey(a.id, b.tokenId as string);
      const lineStart = start.accounts.has(a.id) ? (start.tokensByAccount.get(k) ?? 0) : null;
      const total = lineCurrent.get(k) ?? 0;
      const line = endpointGain(lineStart, total);
      if (line == null) {
        balances[b.id] = null;
        continue;
      }
      const share = total === 0 ? 0 : b.usdValue / total;
      balances[b.id] = { amount: line.amount * share, pct: line.pct };
    }
  }
  return { accounts, balances };
});
