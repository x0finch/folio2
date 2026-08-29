// 曲线的**全部算法**(纯逻辑,可单测):从快照点重建、按归档截断、降采样。
//
// **整块住在这里、由浏览器跑**(FOL-38 / ADR 0049):生产在 Cloudflare Workers 免费档,
// 每个请求只有 10 毫秒 CPU,而曲线的原料很小(每账户每次同步一行)—— 原样发给前端、
// 前端自己算,请求里就只剩「读 + 传」。以前重建与降采样在服务端跑,接口发的是算完的曲线。

// 一条账户快照的总额行(重建组合曲线的输入;manual 账户现算的序列也产这个形状)。
export interface SnapshotTotalRow {
  accountId: string;
  takenAt: number;
  totalUsd: number;
}

export interface HistoryPoint {
  t: number; // epoch ms
  total: number; // 该时刻组合净值
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// 桶粒度阶梯(升序):最细 1 小时、最粗 7 天。降采样时挑"能把点数压到 ≤ maxPoints 的最细桶"。
// **写侧按同一个钟点折叠**(#461,`SnapshotStore.write` 的 `collapseSameHour`),桶宽就是取的
// 这里的最细一档 —— 改动 `HOUR_MS` 这一档要连着那边一起看。
const BUCKET_LADDER = [
  HOUR_MS,
  2 * HOUR_MS,
  4 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
];
const TARGET_MAX_POINTS = 40;

// 自适应降采样:按数据【实际跨度】选桶,每桶保留最后一个点(该桶收盘值),压掉"日内手动多次
// 同步"造成的密集簇,同时让粒度随数据量自适应 —— 约 1 天数据 → 小时级点,约 30 天 → 日级点。
// 快照是事件驱动的(每次同步一个点),直接画会随刷新频率抖动。末点(今日 live 覆写点)天然保留
// → 与主页总额一致。区间可切换的 Insights 视图应自行按 range 选粒度,不复用此处的自适应策略。
export function downsampleSeries(
  series: readonly HistoryPoint[],
  maxPoints = TARGET_MAX_POINTS,
  minBucket = 0,
): HistoryPoint[] {
  if (series.length <= 1) return [...series];
  const span = series[series.length - 1].t - series[0].t; // 约定升序(buildPortfolioHistory 已排序)
  const bucket =
    BUCKET_LADDER.find((b) => b >= minBucket && span / b <= maxPoints) ??
    BUCKET_LADDER[BUCKET_LADDER.length - 1];
  const byBucket = new Map<number, HistoryPoint>();
  for (const p of series) byBucket.set(Math.floor(p.t / bucket), p); // 升序 → 后写覆盖 = 该桶最后一个
  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

// Insights 的走势图专用:**粒度不细于一天**。
//
// 那张图的 X 轴只标到「日」,而上面的自适应策略是按跨度选桶的 —— 6 天数据落在 4 小时桶,
// 于是「同一天里同步了几次」就变成同一天的好几个点,X 轴连着印出 7 个 "Jul 28"。
// (自适应本身没错,主页 hero 那张小图不标 X 轴,细粒度正是它要的。)
export const toDailySeries = (series: readonly HistoryPoint[]): HistoryPoint[] =>
  downsampleSeries(series, TARGET_MAX_POINTS, DAY_MS);

// 归档 = 封存(ADR 0039):账户在归档那一刻之后**不再往曲线贡献**,归档之前的点原样保留。
//
// 为什么这件事非做不可:下面那套阶梯重建会把每个账户的最后一个值**一直保持下去**,而账户一旦
// 归档就不再有新快照 —— 于是它那个冻住的值会跟着曲线一路走到今天。而曲线的当下点是由实时总额
// 覆写的、只算活跃账户。两边口径不一致的结果是:归档之后的每个历史点都含一个幽灵值,只有最右边
// 那个点排除了它,看上去就是「一路平着、到头凭空掉一截」。
//
// 用 `<=`:归档那一刻起就不算了。恰好落在该时刻的快照不再单独冒一个尖。
export type ArchivedAt = ReadonlyMap<string, number>;

// 把「每账户、各自时刻」的快照总额拼成【组合净值随时间】的序列。
//
// 关键:某时刻 T 的组合净值 = Σ 各账户在 T 之前最近一次快照的 totalUsd(账户的 takenAt 并不对齐)。
// 阶梯式重建:按 takenAt 升序遍历,维护 accountId→最近 totalUsd 的累积表,逐事件产出
// { t, total = Σ 当前表 }。同一 takenAt 的多账户事件先全部并入、只产一个点(避免同刻多点)。
export function buildPortfolioHistory(
  rows: readonly SnapshotTotalRow[],
  archivedAt: ArchivedAt = new Map(),
): HistoryPoint[] {
  // 入参约定升序;为稳健起见自排一次(不依赖调用方排序)。
  const sorted = [...rows].sort((a, b) => a.takenAt - b.takenAt);
  const latestByAccount = new Map<string, number>();
  const points: HistoryPoint[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    latestByAccount.set(row.accountId, row.totalUsd);
    // 仅在该 takenAt 的最后一条之后产点 → 同刻多账户合并为一个点。
    const isLastAtThisTime = i + 1 === sorted.length || sorted[i + 1].takenAt !== row.takenAt;
    if (!isLastAtThisTime) continue;
    let total = 0;
    for (const [accountId, v] of latestByAccount) {
      const archived = archivedAt.get(accountId);
      if (archived != null && archived <= row.takenAt) continue;
      total += v;
    }
    points.push({ t: row.takenAt, total });
  }

  return points;
}

// 组合净值曲线接口发来的那份原料(FOL-38):只有快照点、归档时刻,以及末点该算哪些账户,
// 没有任何算过的东西。归档表用 pair 数组而不是 Map —— 它要过一次 JSON。
export interface PortfolioHistoryRaw {
  rows: SnapshotTotalRow[];
  archivedAt: [accountId: string, at: number][];
  /** 末点该由哪些账户的实时净值加起来(= 选中组合里还活着的成员)。 */
  liveAccountIds: string[];
}

/** 总览里按账户的实时净值那一栏。曲线只要这一栏,所以只声明这一栏。 */
export interface AccountTotals {
  accountTotals: readonly { account: { id: string }; totalUsd: number }[];
}

// 原料 → 首页/洞察页那条净值曲线:阶梯重建 + 归档截断,**末点换成实时净值**。
//
// 末点为什么要换:曲线上其它点都是当时冻结的快照值,而最右边那个点说的是「现在」——
// 它必须与主页那个大数字是同一个数,否则同一屏上两处自相矛盾。那个数总览接口已经算过一遍,
// 这里直接用,不为曲线再算一次。
//
// **为什么收的是总览那张按账户的表,而不是它那个总额。**
// 曲线**从不按自定义 Tab 的 pin 收窄**(ADR 0034:pin 只过滤 Tab 里的列表,hero 的总额与曲线
// 保持选中组合的口径),而总览的 `totalUsd` 是**收窄之后**那几个账户的和 —— 把一份 pin 过的总览
// 递进来,末点就会凭空矮一截,而且是静悄悄的。收一个数没法分辨它是哪种,收这张表就可以:
// 逐个对 `liveAccountIds` 取值,**少一个就不换末点**(留住那个冻结值)。于是拿错了顶多是
// 「末点没跟上实时」,不会是「末点是个错的数」。
// 顺带也接住了两条查询之间的时间差(中途新建的账户总览里还没有)—— 同样只是这一帧不换。
export function toPortfolioCurve(
  raw: PortfolioHistoryRaw,
  overview: AccountTotals,
): HistoryPoint[] {
  const series = buildPortfolioHistory(raw.rows, new Map(raw.archivedAt));
  if (series.length === 0) return series;
  const byAccount = new Map(overview.accountTotals.map((a) => [a.account.id, a.totalUsd]));
  let live = 0;
  for (const id of raw.liveAccountIds) {
    const total = byAccount.get(id);
    if (total == null) return series; // 这份总览不是这条曲线的口径 —— 末点保持冻结值
    live += total;
  }
  series[series.length - 1] = { t: series[series.length - 1].t, total: live };
  return series;
}

// 单账户价值历史(A2 抽屉头部 chart):该账户快照 (takenAt, totalUsd) → 升序 HistoryPoint[]。
// 单账户即组合净值阶梯重建的退化情形(每 takenAt 一点),故复用 buildPortfolioHistory + 自适应降采样。
//
// **窗口不在这里裁** —— 接口发来的就是窗口内那一段(见 `lib/server/accounts/history.ts`:
// 窗口是那条接口的上界,交给前端事后过滤等于没有上界)。
//
// `live` = 「当下」那一点,只有手记账户有(账本按当前价现算,与抽屉头 account.totalUsd 同源);
// 快照那条路末点就是最后一次同步的冻结值,不补。已归档的账户也不补 —— 那正是「还在动」的那一笔
// (ADR 0039)。空账户不凭空造点。
export interface AccountHistoryRaw {
  rows: { takenAt: number; totalUsd: number }[];
  /** 「当下」那一点(只有未归档的手记账户有);其余为 `null`。 */
  live: HistoryPoint | null;
}

export function buildAccountValueHistory(
  snapshots: readonly { takenAt: number; totalUsd: number }[],
  live?: HistoryPoint | null,
): HistoryPoint[] {
  const rows: SnapshotTotalRow[] = snapshots.map((s) => ({
    accountId: "_",
    takenAt: s.takenAt,
    totalUsd: s.totalUsd,
  }));
  const series = downsampleSeries(buildPortfolioHistory(rows));
  if (live == null || series.length === 0) return series;
  const last = series[series.length - 1];
  if (last.t >= live.t) series[series.length - 1] = { t: last.t, total: live.total };
  else series.push(live);
  return series;
}
