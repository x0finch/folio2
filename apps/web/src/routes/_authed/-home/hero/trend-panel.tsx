import { type ChartConfig, ChartContainer, ChartTooltip } from "@folio/ui";
import { useEffect, useId } from "react";
import {
  Area,
  AreaChart,
  useActiveTooltipDataPoints,
  useIsTooltipActive,
  XAxis,
  YAxis,
} from "recharts";
import { useTranslations } from "use-intl";
import type { HistoryPoint } from "@/lib/core/history";

// State machine of the value-trend area (too few points / loading / nothing yet / data), so callers
// only pass raw inputs and every surface applies the same thresholds. Defaults suit the drawers
// (topMargin 56 / fillOpacity 0.14); the hero overrides them.
const CHART_TOP_MARGIN = 56;
const CHART_FILL_OPACITY = 0.14;

// Empty state when the curve can't be drawn. A flat line would claim "unchanged" when there is
// only one observation (same rule as 24h PnL showing `—`, not 0); blank space reads as broken. A
// new account's first sync lands here. Rendered only when 0/1 points are certain: while loading,
// it would flash before the chart covers it.
function TrendEmpty({ loading }: { loading: boolean }) {
  const t = useTranslations("Overview");
  if (loading) return null;
  // Bottom-left, not centered: the container is shared with the number overlay, whose big amount
  // sits in the center; the bottom-right is taken by RangeTabs.
  return (
    <div className="absolute inset-0 flex items-end pb-2">
      <p className="text-muted-foreground text-xs">{t("trendNeedsSecondSync")}</p>
    </div>
  );
}

// Value trend area chart shared by the hero and both drawers: line follows --pos/--neg, gradient
// fill, axes hidden; absolutely positioned (inset-0) in a relative + overflow-hidden parent.
// Readouts are not a tooltip bubble: scrubbing reports the point via `onActive` and the caller
// swaps the big number. `<ChartTooltip>` stays with empty content because the vertical cursor line
// and `useIsTooltipActive` / `useActiveTooltipDataPoints` need it. Margins leave room for the
// active dot (the container's overflow clip is deliberate), top is caller-adjustable. Gradient ids
// use useId since hero and drawer can coexist in the DOM.

// Reports the scrubbed point. Must live inside <AreaChart>: the hooks read the chart's store.
function ActivePointReporter({ onActive }: { onActive: (point: HistoryPoint | null) => void }) {
  const active = useIsTooltipActive();
  const points = useActiveTooltipDataPoints<HistoryPoint>();
  const point = active ? (points?.[0] ?? null) : null;
  useEffect(() => {
    onActive(point);
  }, [point, onActive]);
  // Clear on unmount, else the caller's big number sticks on a historical value (switching the
  // window mid-scrub can unmount the chart with too few points, so "leave" never fires).
  useEffect(
    () => () => {
      onActive(null);
    },
    [onActive],
  );
  return null;
}

function ValueTrendChart({
  series,
  topMargin = 8,
  fillOpacity = 0.16,
  onActive,
}: {
  series: HistoryPoint[];
  topMargin?: number;
  fillOpacity?: number;
  /** Called when scrubbing/hovering a point; `null` on release or leave. Omitted = chart only. */
  onActive?: (point: HistoryPoint | null) => void;
}) {
  const gradientId = `value-trend-${useId().replace(/:/g, "")}`;
  if (series.length < 2) return null;
  const up = (series.at(-1)?.total ?? 0) >= (series[0]?.total ?? 0);
  const config = {
    total: { label: "", color: up ? "var(--pos)" : "var(--neg)" },
  } satisfies ChartConfig;
  return (
    // touch-pan-y: vertical swipes still scroll the page, horizontal ones go to the chart.
    <ChartContainer config={config} className="absolute inset-0 h-full w-full touch-pan-y">
      <AreaChart data={series} margin={{ top: topMargin, right: 8, bottom: 8, left: 8 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-total)" stopOpacity={fillOpacity} />
            <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="t" hide />
        <YAxis hide domain={["dataMin", "dataMax"]} />
        {/* content returns null: no bubble, only the cursor line and active dot. */}
        <ChartTooltip
          cursor={{ stroke: "var(--border-2)", strokeDasharray: "3 3" }}
          content={() => null}
        />
        {onActive && <ActivePointReporter onActive={onActive} />}
        <Area
          dataKey="total"
          type="monotone"
          // baseValue pinned to dataMin so the fill stays below the line: "auto" picks baseline 0 when
          // the domain spans 0 (negative history points) and flips the fill above the line.
          baseValue="dataMin"
          stroke="var(--color-total)"
          strokeWidth={2}
          strokeOpacity={0.5}
          fill={`url(#${gradientId})`}
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

// Decorative upward trend for "nothing yet": pure background pattern, no pointer/tooltip, values
// only shape it. Only shown with no holdings and a zero total (the caller's `decorate`); next to a
// real number it would contradict it and pass as market data, so TrendEmpty explains instead.
const DEMO_TREND = [
  0.12, 0.16, 0.13, 0.2, 0.17, 0.24, 0.28, 0.23, 0.31, 0.27, 0.35, 0.41, 0.37, 0.45, 0.52, 0.48,
  0.55, 0.51, 0.6, 0.67, 0.63, 0.72, 0.82, 0.92,
].map((total, t) => ({ t, total }));

function DecorativeTrend({ topMargin }: { topMargin: number }) {
  const t = useTranslations("Overview");
  const config = {
    total: { label: t("portfolioValue"), color: "var(--pos)" },
  } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="pointer-events-none absolute inset-0 h-full w-full">
      <AreaChart data={DEMO_TREND} margin={{ top: topMargin, right: 8, bottom: 8, left: 8 }}>
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
  );
}

export function TrendPanel({
  series,
  loading = false,
  topMargin = CHART_TOP_MARGIN,
  fillOpacity = CHART_FILL_OPACITY,
  decorate = false,
  onActive,
}: {
  series: readonly HistoryPoint[];
  /** Still loading: render nothing, else the empty copy would flash before the chart covers it. */
  loading?: boolean;
  topMargin?: number;
  fillOpacity?: number;
  /** "Nothing yet": draw the decorative pattern instead of explaining. Only allowed when no real number
   * on screen could contradict it (hero: no holdings and zero total); the caller decides. */
  decorate?: boolean;
  /** Scrub/hover readout: reports the current point so the caller can replace the big number. */
  onActive?: (point: HistoryPoint | null) => void;
}) {
  // While loading draw nothing: no flash of decoration/empty copy.
  if (loading) return <TrendEmpty loading />;
  // One point can't make a line; the threshold lives only here.
  if (series.length >= 2) {
    // The chart gets its own overflow clip: callers' containers often float name/amount layers
    // that must not be cut off. The chart is absolute inset-0, so the wrapper doesn't change geometry.
    return (
      <div className="absolute inset-0 overflow-hidden">
        <ValueTrendChart
          series={[...series]}
          topMargin={topMargin}
          fillOpacity={fillOpacity}
          onActive={onActive}
        />
      </div>
    );
  }
  if (decorate) return <DecorativeTrend topMargin={topMargin} />;
  return <TrendEmpty loading={loading} />;
}
