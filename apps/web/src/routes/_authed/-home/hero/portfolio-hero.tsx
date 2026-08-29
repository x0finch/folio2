import { cn } from "@folio/ui";
import { useTranslations } from "use-intl";
import { AmountTicker } from "@/components/amount-ticker";
import { signedUsd } from "@/lib/core/format-number";
import { downsampleSeries, type HistoryPoint } from "@/lib/core/history";
import type { Gain } from "@/lib/core/portfolio";
import { useChartScrub } from "@/lib/hooks/use-chart-scrub";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { GainSkeleton, NO_VALUE } from "@/routes/_authed/-home/holdings/value-delta";
import { deriveHeroMetrics, type HoldingLike } from "./hero-stats";
import { Stat } from "./stat";
import { TrendPanel } from "./trend-panel";

const DAY_MS = 86_400_000;
// hero 趋势最多展示最近 30 天;更长跨度 + 区间切换属于 Insights(不改共享的 getPortfolioHistory)。
const HERO_WINDOW_DAYS = 30;
const GAIN_BADGE =
  "inline-flex items-center rounded-full px-2 py-0.5 font-mono font-semibold text-xs tabular-nums";
const GAIN_TONE = {
  flat: "bg-muted text-muted-foreground",
  pos: "bg-pos-bg text-pos",
  neg: "bg-neg-bg text-neg",
} as const;

function gainTone(amount: number) {
  if (amount > 0) return GAIN_TONE.pos;
  if (amount < 0) return GAIN_TONE.neg;
  return GAIN_TONE.flat;
}

// 24h 盈亏药丸:贴在净值数字右上角。文案与代币行同形(`{±}$Δ P%`),底色走涨跌 token。
function GainBadge({
  gain,
  pending,
  failed,
}: {
  gain: Gain | null;
  pending: boolean;
  failed: boolean;
}) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();

  switch (true) {
    case pending:
      return <GainSkeleton />;
    case failed:
      return (
        <div>
          <span className={cn(GAIN_BADGE, GAIN_TONE.flat)}>{NO_VALUE}</span>
          <p className="mt-1 text-muted-foreground text-xs">{t("gainLoadFailed")}</p>
        </div>
      );
    case gain == null:
      return <span className={cn(GAIN_BADGE, GAIN_TONE.flat)}>{NO_VALUE}</span>;
    default:
      return (
        <span className={cn(GAIN_BADGE, gainTone(gain.amount))}>
          {signedUsd(usd, gain.amount)}
          {gain.pct != null && ` ${Math.abs(gain.pct).toFixed(2)}%`}
        </span>
      );
  }
}

// 净值 hero(H3 #102):趋势图作背景 + 净值/24h/三指标浮于其上(无 Card)。
// 趋势色随涨跌走 --pos/--neg;三指标 best/worst/稳定币占比派生自纯函数 deriveHeroMetrics(已单测)。
export function PortfolioHero({
  series,
  totalUsd,
  gain24h,
  holdings,
  loading = false,
  gainPending = false,
  gainFailed = false,
  contentClassName,
}: {
  series: HistoryPoint[];
  totalUsd: number;
  // 组合层 24h 盈亏(ADR 0040),由独立读取算好 —— **不在这里从曲线上量**。
  // 曲线画的是净值(含充提),这个数剔除了充提,两者本来就不该是同一个;`null` = 算不出。
  gain24h: Gain | null;
  holdings: readonly HoldingLike[];
  /** 净值曲线还在取 —— 数字照常渲染,曲线走 TrendPanel 的「还在取数」态。 */
  loading?: boolean;
  /** 24h 盈亏还在取 —— 增量 / best-worst 走小骨架,不跟「算不出」的破折号混。 */
  gainPending?: boolean;
  /** 盈亏读取失败 —— 破折号旁边一处提示。行内不再各说一遍。 */
  gainFailed?: boolean;
  // 附加到文案层(数字/指标)的 class —— 只影响文字覆盖层,不动趋势图。默认空,主页不传 → 零影响。
  contentClassName?: string;
}) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  // 划动读数(#470 片7):划到哪个点、那一刻怎么写,都在这个 hook 里。
  const scrub = useChartScrub();

  // 裁到最近 30 天窗口(以最新快照时刻为基准,与 SSR/客户端一致、不用客户端时钟),
  // 再自适应降采样:粒度随实际数据量走(约 1 天 → 小时级、约 30 天 → 日级),日内多次手动
  // 同步塌缩成"该桶最后一个点",避免刷新频率抖动图形。
  const lastT = series.length > 0 ? series[series.length - 1].t : 0;
  const chartSeries = downsampleSeries(
    series.filter((p) => p.t >= lastT - HERO_WINDOW_DAYS * DAY_MS),
  );
  const hasHistory = chartSeries.length >= 2;
  // 「还什么都没有」—— 只有这一种情况留那条装饰线(见下面 JSX 里的分支)。
  //
  // **判据是「有没有东西」,不是「有没有钱」。** 一开始写的是 `totalUsd > 0`,那样净值为**负**
  // 会掉进装饰线那支:perp 亏穿时屏幕上是「净值 −$X」配一条平滑上扬的绿线,比 0 那种更糟。
  // 而持有价值恰好为 0 的灰尘仓位也仍然是「有仓位」—— 那时该说明原因,不该画背景纹样。
  const nothingYet = holdings.length === 0 && totalUsd === 0;

  // 24h 盈亏(ADR 0040):server 按快照历史 / 账本分段算好 —— 以前这里是「现在总额 − 约 24 小时前
  // 总额」,那是净值差:你充值 10 万,它就显示赚了 10 万。现在剔除了充提与买卖。
  //
  // **这个数与脚下那条曲线不再对得上,那是预期的。** 曲线画的是净值,充值那天它会跳一格而这个数
  // 不动。两个要求没法同时满足(金额要是真赚的钱 / 要剔除资金进出)。
  const metrics = deriveHeroMetrics(holdings, totalUsd);
  const spanDays = hasHistory
    ? Math.round((chartSeries[chartSeries.length - 1].t - chartSeries[0].t) / DAY_MS)
    : 0;

  // 大数字显示的是**划到的那个点,或者实时值** —— 同一个位置、同一套元素(#470 片7)。
  const shownUsd = scrub.point ? scrub.point.total : totalUsd;

  return (
    <div className="relative min-h-60 overflow-hidden pt-1">
      {/* 四态(点数不够 / 还在取数 / 什么都还没有 / 真有数据)全在 TrendPanel 里判。
          hero 的上留白更大(topMargin=92,把折线压到下半区),填充也比抽屉略重 → 覆盖这两个默认值。 */}
      <TrendPanel
        series={chartSeries}
        loading={loading}
        topMargin={92}
        fillOpacity={0.16}
        decorate={nothingYet}
        onActive={scrub.onActive}
      />

      {/* 数字层:浮于图上,不吃指针(hover 透传给背景图)。 */}
      <div className={cn("pointer-events-none relative z-10", contentClassName)}>
        {/* 划到某点时,标题换成那个时刻(#470 片7)—— 大数字顶替成该点的值,两者一起才说得清
            「这是哪一刻的数」。 */}
        <p className="font-medium text-muted-foreground text-xs tabular-nums">
          {scrub.label ?? t("totalNetWorth")}
        </p>
        {/* select-text:总净值是最该能复制的那个数(hero 整块坐在可点区域里)。
            inline-flex + items-start:24h 增量贴在金额盒子的右上角,不跟数字基线居中。 */}
        <div className="mt-2 inline-flex items-start gap-3">
          {/* select-text:总净值是最该能复制的那个数。滚动与「整数/小数怎么拆」走 AmountTicker
              (两个抽屉同一份);hero 的字号在这里给 —— 它比抽屉大两档。 */}
          <div className="flex select-text items-baseline">
            <AmountTicker
              value={shownUsd}
              scrubbing={scrub.point != null}
              className="font-mono font-semibold text-4xl tracking-tight sm:text-5xl"
              fractionClassName="font-mono font-semibold text-2xl text-muted-foreground sm:text-3xl"
            />
          </div>
          {/* 划动时不显 24h 药丸:那是「今天涨跌」,摆在一个历史时刻的数值旁边是两件事对不上。 */}
          {scrub.point ? null : (
            <GainBadge gain={gain24h} pending={gainPending} failed={gainFailed} />
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-8">
          {/* 「今天赚 / 亏最多的那个仓」—— 按盈亏**金额**取,不按涨跌幅(ADR 0040)。以前只看涨跌幅、
              不看持有多少,于是这两格永远被小仓位的暴涨币占据。金额走 usd() → 跟随展示币种。 */}
          <Stat
            label={t("bestToday")}
            value={
              gainPending ? (
                <GainSkeleton />
              ) : metrics.best ? (
                `${metrics.best.symbol} ${signedUsd(usd, metrics.best.amount)}`
              ) : (
                NO_VALUE
              )
            }
          />
          <Stat
            label={t("worstToday")}
            value={
              gainPending ? (
                <GainSkeleton />
              ) : metrics.worst ? (
                `${metrics.worst.symbol} ${signedUsd(usd, metrics.worst.amount)}`
              ) : (
                NO_VALUE
              )
            }
          />
          <Stat
            label={t("stableShare")}
            value={
              metrics.stableShare == null ? NO_VALUE : `${Math.round(metrics.stableShare * 100)}%`
            }
          />
        </div>
      </div>

      {spanDays >= 1 && (
        <span className="absolute right-0 bottom-2 z-10 font-mono text-muted-foreground text-xs tracking-wide">
          {spanDays}D
        </span>
      )}
    </div>
  );
}
