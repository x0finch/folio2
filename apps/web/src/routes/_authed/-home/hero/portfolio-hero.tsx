import { cn, Skeleton } from "@folio/ui";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { AmountTicker } from "@/components/amount-ticker";
import { Sensitive } from "@/components/sensitive";
import { signedUsd } from "@/lib/core/format-number";
import { downsampleSeries, type HistoryPoint } from "@/lib/core/history";
import type { Gain } from "@/lib/core/portfolio";
import { useChartScrub } from "@/lib/hooks/use-chart-scrub";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { NO_VALUE } from "@/routes/_authed/-home/holdings/value-delta";
import { deriveHeroMetrics, type HoldingLike } from "./hero-stats";
import { Stat } from "./stat";
import { TrendPanel } from "./trend-panel";

const DAY_MS = 86_400_000;
// hero 趋势最多展示最近 30 天;更长跨度 + 区间切换属于 Insights(不改共享的 getPortfolioHistory)。
const HERO_WINDOW_DAYS = 30;
// hero 净值 ≥ 此额才启用缩写(小于则本来就放得下、缩写没意义)。
const HERO_COMPACT_MIN = 1_000_000;
const GAIN_BADGE =
  "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 font-mono font-semibold text-xs tabular-nums";
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

// 窄屏(< sm=640):hero 默认用紧凑金额,给「缩写 + 涨跌幅同行」腾地方;桌面默认完整。
// 只决定**默认**态,用户点击总额后由 compactOverride 接管。
function useIsNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

// 24h 盈亏药丸:贴在净值数字右上角。文案与代币行同形(`{±}$Δ P%`),底色走涨跌 token。
// **盈亏 FOL-51 起随总览一起到,没有「还在取」的态** —— 只剩两态:算得出(数)/ 算不出(`—`)。
function GainBadge({ gain, compact = false }: { gain: Gain | null; compact?: boolean }) {
  const usd = useDisplayValue();
  if (gain == null) return <span className={cn(GAIN_BADGE, GAIN_TONE.flat)}>{NO_VALUE}</span>;
  return (
    <span className={cn(GAIN_BADGE, gainTone(gain.amount))}>
      {/* 遮 24h 盈亏金额,留百分比(ADR 0052)。 */}
      <Sensitive>{signedUsd((n) => usd(n, { compact }), gain.amount)}</Sensitive>
      {gain.pct != null && ` ${Math.abs(gain.pct).toFixed(2)}%`}
    </span>
  );
}

// 净值 hero(H3 #102):趋势图作背景 + 净值/24h/三指标浮于其上(无 Card)。
// 趋势色随涨跌走 --pos/--neg;三指标 best/worst/稳定币占比派生自纯函数 deriveHeroMetrics(已单测)。
export function PortfolioHero({
  series,
  totalUsd,
  gain24h,
  holdings,
  loading = false,
  syncing = false,
  contentClassName,
}: {
  series: HistoryPoint[];
  totalUsd: number;
  // 组合层 24h 盈亏(ADR 0050,两端相减),随总览原料一起到 —— **不在这里从曲线上量**。
  // 曲线画的是净值(含充提),这个数是「现值 − 24 小时前值」,两者本来就不该是同一个;`null` = 算不出。
  gain24h: Gain | null;
  holdings: readonly HoldingLike[];
  /** 净值曲线还在取 —— 数字照常渲染,曲线走 TrendPanel 的「还在取数」态。 */
  loading?: boolean;
  /** 首次同步中(有账户、还没有任何快照)—— 大数字走骨架、标题换「同步中」,不把 $0 当答案画。 */
  syncing?: boolean;
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

  // 24h 盈亏(ADR 0050,两端相减):现值 − 24 小时前值,随总览一起到。best/worst 按盈亏金额挑,
  // 所以要这份 metrics。充提计入当天盈亏(设计),曲线画的是净值(含充提),两者一致 —— 充值那天
  // 曲线跳一格、这个数也跟着 +10 万,不再互相矛盾。
  const metrics = deriveHeroMetrics(holdings, totalUsd);
  const spanDays = hasHistory
    ? Math.round((chartSeries[chartSeries.length - 1].t - chartSeries[0].t) / DAY_MS)
    : 0;

  // 大数字显示的是**划到的那个点,或者实时值** —— 同一个位置、同一套元素(#470 片7)。
  const shownUsd = scrub.point ? scrub.point.total : totalUsd;

  // 紧凑金额:窄屏默认开(给「缩写 + 涨跌幅同行」腾地)、桌面默认关;点击总额后由 override 接管。
  // 只在净值 ≥ HERO_COMPACT_MIN 时才真正缩写 —— 小额放得下、缩写没意义。总额与 badge 共用它。
  const isNarrow = useIsNarrow();
  const [compactOverride, setCompactOverride] = useState<boolean | null>(null);
  const showCompact = (compactOverride ?? isNarrow) && shownUsd >= HERO_COMPACT_MIN;

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
          {scrub.label ?? (syncing ? t("firstSyncing") : t("totalNetWorth"))}
        </p>
        {/* select-text:总净值是最该能复制的那个数(hero 整块坐在可点区域里)。
            inline-flex + items-start:24h 增量贴在金额盒子的右上角,不跟数字基线居中。 */}
        <div className="mt-2 inline-flex flex-wrap items-start gap-3">
          {/* select-text:总净值是最该能复制的那个数。滚动与「整数/小数怎么拆」走 AmountTicker
              (两个抽屉同一份);hero 的字号在这里给 —— 它比抽屉大两档。 */}
          {/* 点击总额切换缩写↔完整(pointer-events-auto 覆盖数字层的 none):金额 ≥ $1M 时缩写省地、
              涨跌幅同行,再点回完整。数字区在图上半、非划动区,吃指针不影响趋势 scrub。 */}
          <button
            type="button"
            onClick={() => setCompactOverride((v) => !(v ?? isNarrow))}
            aria-label={showCompact ? "显示完整金额" : "显示缩写金额"}
            className="pointer-events-auto flex w-fit cursor-pointer select-text items-baseline text-left"
          >
            {syncing ? (
              // 首次同步中:大数字位摆骨架,别把「还不知道」画成 $0(见 index.tsx 的 pending 判据)。
              <Skeleton className="h-11 w-52 rounded-lg sm:h-14 sm:w-64" />
            ) : (
              // 隐私开着时 AmountTicker 自己渲染静态模糊值(ADR 0052),点一下临时显示 —— 这里不必再包。
              <AmountTicker
                value={shownUsd}
                scrubbing={scrub.point != null}
                compact={showCompact}
                className="font-mono font-semibold text-4xl tracking-tight sm:text-5xl"
                fractionClassName="font-mono font-semibold text-2xl text-muted-foreground sm:text-3xl"
              />
            )}
          </button>
          {/* 划动时不显 24h 药丸:那是「今天涨跌」,摆在一个历史时刻的数值旁边是两件事对不上。 */}
          {scrub.point ? null : <GainBadge gain={gain24h} compact={showCompact} />}
        </div>

        <div className="mt-6 flex flex-wrap gap-8">
          {/* 「今天赚 / 亏最多的那个仓」—— 按盈亏**金额**取,不按涨跌幅(ADR 0050)。以前只看涨跌幅、
              不看持有多少,于是这两格永远被小仓位的暴涨币占据。金额走 usd() → 跟随展示币种。
              盈亏随总览一起到,没有「还在取」的态 —— best/worst 直接算得出或 `—`。 */}
          {/* 遮盈亏金额,留 symbol(公开的币名);占比是百分比,整格不遮。 */}
          <Stat
            label={t("bestToday")}
            value={
              metrics.best ? (
                <>
                  {metrics.best.symbol} <Sensitive>{signedUsd(usd, metrics.best.amount)}</Sensitive>
                </>
              ) : (
                NO_VALUE
              )
            }
          />
          <Stat
            label={t("worstToday")}
            value={
              metrics.worst ? (
                <>
                  {metrics.worst.symbol}{" "}
                  <Sensitive>{signedUsd(usd, metrics.worst.amount)}</Sensitive>
                </>
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
