import { Sparkline } from "@folio/ui";
import { useTranslations } from "use-intl";
import type { HistoryPoint } from "@/lib/core/history";
import { PortfolioChart } from "@/routes/_authed/-insights/portfolio-chart";

// Plot height in both drawers.
export const SHEET_TREND_HEIGHT = 128;

// Empty state when the curve can't be drawn. A flat line would claim "unchanged" when there is
// only one observation (same rule as 24h PnL showing `—`, not 0); blank space reads as broken. A
// new account's first sync lands here.
function TrendEmpty() {
  const t = useTranslations("Overview");
  return (
    <div className="absolute inset-0 flex items-end pb-2">
      <p className="text-muted-foreground text-xs">{t("trendNeedsSecondSync")}</p>
    </div>
  );
}

// Decorative upward trend for "nothing yet": pure background pattern, values only shape it. Only
// shown with no holdings and a zero total (the caller's `decorate`); next to a real number it
// would contradict it and pass as market data, so TrendEmpty explains instead.
const DEMO_TREND = [
  0.12, 0.16, 0.13, 0.2, 0.17, 0.24, 0.28, 0.23, 0.31, 0.27, 0.35, 0.41, 0.37, 0.45, 0.52, 0.48,
  0.55, 0.51, 0.6, 0.67, 0.63, 0.72, 0.82, 0.92,
];

// Value trend shared by the hero and both drawers, with every state decided here so each surface
// applies the same thresholds. `height` is the plot's, without its axis labels.
export function TrendPanel({
  series,
  height,
  loading = false,
  decorate = false,
}: {
  series: readonly HistoryPoint[];
  height: number;
  /** Still loading: render nothing, else the empty copy would flash before the chart covers it. */
  loading?: boolean;
  /** "Nothing yet": draw the decorative pattern instead of explaining. Only allowed when no real
   * number on screen could contradict it (hero: no holdings and zero total); the caller decides. */
  decorate?: boolean;
}) {
  const t = useTranslations("Overview");
  if (loading) return null;
  // One point can't make a line; the threshold lives only here.
  if (series.length >= 2) return <PortfolioChart series={series} height={height} />;
  if (decorate) {
    return (
      <Sparkline
        className="pointer-events-none absolute inset-0 text-muted-foreground"
        aria-hidden
        label={t("portfolioValue")}
        data={DEMO_TREND}
        variant="area"
        height={height}
      />
    );
  }
  return <TrendEmpty />;
}
