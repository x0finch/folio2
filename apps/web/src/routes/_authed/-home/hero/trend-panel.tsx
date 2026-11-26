import { Sparkline, useHoverCapable, XYInspector } from "@folio/ui";
import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import type { HistoryPoint } from "@/lib/core/history";
import { useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";
import { useDisplayValue } from "@/lib/hooks/use-display-value";

// The band the curve occupies at the bottom of its backdrop container, in px.
const TREND_HEIGHT = 128;
// Sparkline insets its line by this much on each side; the scrub cursor has to match it.
const SPARKLINE_PAD_PX = 3;
const HIDDEN_VALUE = "•••";

// Empty state when the curve can't be drawn. A flat line would claim "unchanged" when there is
// only one observation (same rule as 24h PnL showing `—`, not 0); blank space reads as broken. A
// new account's first sync lands here.
function TrendEmpty() {
  const t = useTranslations("Overview");
  // Bottom-left, not centered: the container is shared with the number overlay, whose big amount
  // sits in the center; the bottom-right is taken by RangeTabs.
  return (
    <div className="absolute inset-0 flex items-end pb-2">
      <p className="text-muted-foreground text-xs">{t("trendNeedsSecondSync")}</p>
    </div>
  );
}

// The curve is beUI's Sparkline; beUI's XYInspector on top turns hover, drag and arrow keys into a
// sample index. No readout bubble: the caller swaps its big number for the reported point.
function ValueTrend({
  series,
  onActive,
}: {
  series: readonly HistoryPoint[];
  onActive?: (point: HistoryPoint | null) => void;
}) {
  const t = useTranslations("Overview");
  const format = useFormatter();
  const usd = useDisplayValue();
  const { hidden } = useBalancePrivacy();
  // The accessible name and the slider's value text carry amounts too.
  const readout = (value: number) => (hidden ? HIDDEN_VALUE : usd(value));
  const canHover = useHoverCapable();
  const [index, setIndex] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  // The inspector opens on focus, and a sheet moves focus to its first control when it opens:
  // without a pointer or key on the chart itself that would open the sheet mid-scrub.
  const engaged = useRef(false);
  const engage = () => {
    engaged.current = true;
  };
  // A sample inspected before the window changed may no longer exist.
  const active = open && index !== null && index < series.length ? index : null;
  const point = active === null ? null : series[active];
  useEffect(() => {
    onActive?.(point);
  }, [point, onActive]);
  // Clear on unmount, else the caller's big number sticks on a historical value (switching the
  // window mid-scrub can unmount the chart with too few points, so "leave" never fires).
  useEffect(() => () => onActive?.(null), [onActive]);
  const label = t("portfolioValue");
  const when = (p: HistoryPoint) =>
    format.dateTime(new Date(p.t), { month: "short", day: "numeric" });
  return (
    // touch-pan-y: vertical swipes still scroll the page, horizontal ones go to the chart.
    <div
      className="absolute inset-x-0 bottom-0 touch-pan-y"
      style={{ height: TREND_HEIGHT }}
      onPointerEnter={engage}
      onPointerMoveCapture={engage}
      onPointerDownCapture={engage}
      onKeyDownCapture={engage}
    >
      <Sparkline
        label={label}
        data={series.map((p) => p.total)}
        variant="area"
        color="var(--chart-1)"
        height={TREND_HEIGHT}
        formatValue={readout}
      />
      {active !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-border-2"
          style={{
            left: `calc(${SPARKLINE_PAD_PX}px + (100% - ${2 * SPARKLINE_PAD_PX}px) * ${active / (series.length - 1)})`,
          }}
        />
      )}
      {onActive && (
        <XYInspector
          count={series.length}
          activeIndex={active ?? -1}
          onActive={setIndex}
          label={label}
          valueText={(i) => `${when(series[i])}: ${readout(series[i].total)}`}
          mode="point"
          open={open}
          setOpen={(next) => setOpen(next && engaged.current)}
          canHover={canHover}
          className="inset-0 size-full"
        />
      )}
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

// Value trend shared by the hero and both drawers as the backdrop of a relative parent, with every
// state decided here so each surface applies the same thresholds.
export function TrendPanel({
  series,
  loading = false,
  decorate = false,
  onActive,
}: {
  series: readonly HistoryPoint[];
  /** Still loading: render nothing, else the empty copy would flash before the chart covers it. */
  loading?: boolean;
  /** "Nothing yet": draw the decorative pattern instead of explaining. Only allowed when no real
   * number on screen could contradict it (hero: no holdings and zero total); the caller decides. */
  decorate?: boolean;
  /** Scrub/hover readout: reports the current point so the caller can replace the big number. */
  onActive?: (point: HistoryPoint | null) => void;
}) {
  const t = useTranslations("Overview");
  if (loading) return null;
  // One point can't make a line; the threshold lives only here.
  if (series.length >= 2) return <ValueTrend series={series} onActive={onActive} />;
  if (decorate) {
    return (
      <Sparkline
        className="pointer-events-none absolute inset-x-0 bottom-0 text-muted-foreground"
        aria-hidden
        label={t("portfolioValue")}
        data={DEMO_TREND}
        variant="area"
        height={TREND_HEIGHT}
      />
    );
  }
  return <TrendEmpty />;
}
