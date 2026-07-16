import { type ChartConfig, ChartContainer, cn, NumberTicker } from "@folio/ui";
import { Area, AreaChart, YAxis } from "recharts";
import { useTranslations } from "use-intl";
import { computeDayChange } from "../lib/day-change";
import { deriveHeroMetrics, type HoldingLike } from "../lib/hero-stats";
import { downsampleSeries, type HistoryPoint } from "../lib/history";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { signedUsd } from "../lib/signed-usd";
import { Stat } from "./stat";
import { ValueTrendChart } from "./value-trend-chart";

const DAY_MS = 86_400_000;
// hero 趋势最多展示最近 30 天;更长跨度 + 区间切换属于 Insights(不改共享的 getPortfolioHistory)。
const HERO_WINDOW_DAYS = 30;

// 历史不足(<2 点)时的演示趋势:曲折上扬(有涨有跌但净向上,末点最高),纯背景装饰 ——
// 实线平滑曲线(type=natural,非折线)、不吃指针、无 hover/tooltip。值仅用于形状(轴全隐藏)。
const DEMO_TREND = [
  0.12, 0.16, 0.13, 0.2, 0.17, 0.24, 0.28, 0.23, 0.31, 0.27, 0.35, 0.41, 0.37, 0.45, 0.52, 0.48,
  0.55, 0.51, 0.6, 0.67, 0.63, 0.72, 0.82, 0.92,
].map((total, t) => ({ t, total }));

const fmtPct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

// 净值 hero(H3 #102):趋势图作背景 + 净值/24h/三指标浮于其上(无 Card)。
// 趋势色随涨跌走 --pos/--neg;三指标 best/worst/稳定币占比派生自纯函数 deriveHeroMetrics(已单测)。
export function PortfolioHero({
  series,
  totalUsd,
  holdings,
}: {
  series: HistoryPoint[];
  totalUsd: number;
  holdings: readonly HoldingLike[];
}) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();

  // 裁到最近 30 天窗口(以最新快照时刻为基准,与 SSR/客户端一致、不用客户端时钟),
  // 再自适应降采样:粒度随实际数据量走(约 1 天 → 小时级、约 30 天 → 日级),日内多次手动
  // 同步塌缩成"该桶最后一个点",避免刷新频率抖动图形。
  const lastT = series.length > 0 ? series[series.length - 1].t : 0;
  const chartSeries = downsampleSeries(
    series.filter((p) => p.t >= lastT - HERO_WINDOW_DAYS * DAY_MS),
  );
  const hasHistory = chartSeries.length >= 2;

  // 24h 净值变化:绝对差(day-change.ts)+ 由基准反推百分比(基准 ≤ 0 时只显示绝对额,不连带隐藏)。
  const dayAbs = computeDayChange(series, totalUsd, series.at(-1)?.t ?? 0);
  const baseline = dayAbs == null ? null : totalUsd - dayAbs;
  const dayPct =
    dayAbs != null && baseline != null && baseline > 0 ? (dayAbs / baseline) * 100 : null;
  // 方向:正/负/持平(0 → 中性,不当作上涨)。
  const dir = dayAbs == null ? 0 : dayAbs > 0 ? 1 : dayAbs < 0 ? -1 : 0;
  const toneClass =
    dir > 0
      ? "bg-pos-bg text-pos"
      : dir < 0
        ? "bg-neg-bg text-neg"
        : "bg-muted text-muted-foreground";
  const arrow = dir > 0 ? "▲" : dir < 0 ? "▼" : null;

  const metrics = deriveHeroMetrics(holdings, totalUsd);
  const spanDays = hasHistory
    ? Math.round((chartSeries[chartSeries.length - 1].t - chartSeries[0].t) / DAY_MS)
    : 0;

  // 拆整数/小数:NumberTicker 内部 Math.round(value) → 若直接 format 整个金额,分位恒为 .00 且整数被进位;
  // 故整数走 ticker(format 取小数点前),小数单独渲染。
  const totalStr = usd(totalUsd);
  const dot = totalStr.lastIndexOf(".");
  const fracPart = dot >= 0 ? totalStr.slice(dot + 1) : null;

  const demoConfig = {
    total: { label: t("portfolioValue"), color: "var(--pos)" },
  } satisfies ChartConfig;

  return (
    <div className="relative min-h-60 overflow-hidden pt-1">
      {hasHistory ? (
        // 上留白把折线压到下半区(topMargin=92);共用 ValueTrendChart(--pos/--neg + tooltip + 各边留白给圆点)。
        <ValueTrendChart series={chartSeries} topMargin={92} />
      ) : (
        // 演示趋势:纯背景装饰,不吃指针、无 tooltip;实线、曲折上扬。
        <ChartContainer
          config={demoConfig}
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <AreaChart data={DEMO_TREND} margin={{ top: 92, right: 8, bottom: 8, left: 8 }}>
            <defs>
              <linearGradient id="hero-fill-demo" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-total)" stopOpacity={0.12} />
                <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Area
              dataKey="total"
              type="natural"
              stroke="var(--color-total)"
              strokeWidth={2}
              strokeOpacity={0.45}
              fill="url(#hero-fill-demo)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      )}

      {/* 数字层:浮于图上,不吃指针(hover 透传给背景图)。 */}
      <div className="pointer-events-none relative z-10">
        <p className="font-medium text-muted-foreground text-xs">{t("totalNetWorth")}</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <div className="flex items-baseline">
            <NumberTicker
              value={totalUsd}
              format={(n) => usd(n).split(".")[0]}
              className="font-mono font-semibold text-4xl tracking-tight sm:text-5xl"
            />
            {fracPart && (
              <span className="font-mono font-semibold text-2xl text-muted-foreground sm:text-3xl">
                .{fracPart}
              </span>
            )}
          </div>
          {dayAbs != null && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 self-start rounded-full px-2 py-0.5 font-mono font-semibold text-xs",
                toneClass,
              )}
            >
              {arrow ? `${arrow} ` : ""}
              {dayPct != null ? `${fmtPct(dayPct)} · ` : ""}
              {signedUsd(usd, dayAbs)}
            </span>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-8">
          <Stat
            label={t("bestToday")}
            value={metrics.best ? `${metrics.best.symbol} ${fmtPct(metrics.best.change24h)}` : "—"}
          />
          <Stat
            label={t("worstToday")}
            value={
              metrics.worst ? `${metrics.worst.symbol} ${fmtPct(metrics.worst.change24h)}` : "—"
            }
          />
          <Stat
            label={t("stableShare")}
            value={metrics.stableShare == null ? "—" : `${Math.round(metrics.stableShare * 100)}%`}
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
