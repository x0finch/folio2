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
const HERO_WINDOW_DAYS = 30;
const HERO_COMPACT_MIN = 1_000_000;
const GAIN_BADGE =
  "inline-flex shrink-0 items-center whitespace-nowrap py-1 font-mono font-semibold text-sm tabular-nums";
// Text only: functional colours never fill an area (DESIGN.md).
const GAIN_TONE = {
  flat: "text-muted-foreground",
  pos: "text-pos",
  neg: "text-neg",
} as const;

function gainTone(amount: number) {
  if (amount > 0) return GAIN_TONE.pos;
  if (amount < 0) return GAIN_TONE.neg;
  return GAIN_TONE.flat;
}

// Narrow screens (< sm=640) default to compact amounts; the user's click then takes over via compactOverride.
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

// 24h PnL pill at the top right of the number; it arrives with the overview, so only two states: a value or `—`.
function GainBadge({ gain, compact = false }: { gain: Gain | null; compact?: boolean }) {
  const usd = useDisplayValue();
  if (gain == null) return <span className={cn(GAIN_BADGE, GAIN_TONE.flat)}>{NO_VALUE}</span>;
  return (
    <span className={cn(GAIN_BADGE, gainTone(gain.amount))}>
      {/* Masks the PnL amount, keeps the percentage. */}
      <Sensitive>{signedUsd((n) => usd(n, { compact }), gain.amount)}</Sensitive>
      {gain.pct != null && ` ${Math.abs(gain.pct).toFixed(2)}%`}
    </span>
  );
}

// Net-worth hero: trend chart as background with number / 24h / three metrics floating over it.
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
  // Portfolio 24h PnL (two-ended subtraction) arrives with the overview; deliberately not measured
  // off the curve, which plots net worth including deposits. `null` = not computable.
  gain24h: Gain | null;
  holdings: readonly HoldingLike[];
  /** Curve still loading: numbers render, the curve shows TrendPanel's loading state. */
  loading?: boolean;
  /** First sync (accounts but no snapshot): skeleton number and "syncing" title instead of $0. */
  syncing?: boolean;
  // Class for the text layer only; doesn't affect the chart.
  contentClassName?: string;
}) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  // Scrub readout: which point and how it's labelled live in this hook.
  const scrub = useChartScrub();

  // Clip to the last 30 days (relative to the latest snapshot, not the client clock) and
  // downsample adaptively; same-day manual syncs collapse to the bucket's last point.
  const lastT = series.length > 0 ? series[series.length - 1].t : 0;
  const chartSeries = downsampleSeries(
    series.filter((p) => p.t >= lastT - HERO_WINDOW_DAYS * DAY_MS),
  );
  const hasHistory = chartSeries.length >= 2;
  // "Nothing yet" is the only case that keeps the decorative line. Keyed on holdings, not on
  // `totalUsd > 0`: a negative net worth (perp blown through) would otherwise show a rising green line.
  const nothingYet = holdings.length === 0 && totalUsd === 0;

  // best/worst pick by PnL amount, hence these metrics.
  const metrics = deriveHeroMetrics(holdings, totalUsd);
  const spanDays = hasHistory
    ? Math.round((chartSeries[chartSeries.length - 1].t - chartSeries[0].t) / DAY_MS)
    : 0;

  // The big number shows the scrubbed point or the live value.
  const shownUsd = scrub.point ? scrub.point.total : totalUsd;

  // Compact: default on for narrow, off for desktop; a click overrides. Only abbreviates at
  // >= HERO_COMPACT_MIN. Shared by the total and the badge.
  const isNarrow = useIsNarrow();
  const [compactOverride, setCompactOverride] = useState<boolean | null>(null);
  const showCompact = (compactOverride ?? isNarrow) && shownUsd >= HERO_COMPACT_MIN;

  return (
    <div className="min-h-60 pt-1">
      <div className={contentClassName}>
        {/* While scrubbing the title shows that moment, since the big number is the scrubbed value. */}
        {/* No caption at rest: the figure under the page title needs none. The line keeps its height
            so the number doesn't jump when a scrub label appears. */}
        <p className="h-4 font-medium text-muted-foreground text-xs tabular-nums">
          {scrub.label ?? (syncing ? t("firstSyncing") : null)}
        </p>
        {/* select-text: the total is the number most worth copying. inline-flex + items-start puts the 24h delta at the top right. */}
        <div className="mt-2 inline-flex flex-wrap items-start gap-3">
          {/* Rolling and integer/decimal split use AmountTicker (shared with both drawers). Clicking the
              total toggles compact (pointer-events-auto overrides the layer's none); it sits in the
              non-scrub upper half. */}
          <button
            type="button"
            onClick={() => setCompactOverride((v) => !(v ?? isNarrow))}
            aria-label={showCompact ? "显示完整金额" : "显示缩写金额"}
            className="flex w-fit cursor-pointer select-text items-baseline text-left"
          >
            {syncing ? (
              // First sync: skeleton instead of drawing "unknown" as $0 (see index.tsx's pending check).
              <Skeleton className="h-11 w-52 rounded-lg sm:h-14 sm:w-64" />
            ) : (
              // With privacy on, AmountTicker renders a static blurred value itself; no wrapper needed.
              <AmountTicker
                value={shownUsd}
                scrubbing={scrub.point != null}
                compact={showCompact}
                className="font-mono font-semibold text-4xl tracking-tight sm:text-5xl"
                fractionClassName="font-mono font-semibold text-2xl text-muted-foreground sm:text-3xl"
              />
            )}
          </button>
          {/* Hide the 24h pill while scrubbing: it's "today's change" beside a historical value. */}
          {scrub.point ? null : <GainBadge gain={gain24h} compact={showCompact} />}
        </div>

        <div className="mt-8 flex flex-wrap gap-12">
          {/* Best / worst position by PnL amount (not percent). Amounts go through usd() to follow the
              display currency. Masks the PnL amount, keeps the symbol; the percentage stays unmasked. */}
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

      {/* The chart has its own band under the figures, so the line never runs behind text.
          overflow-hidden clips the active dot at the edges. TrendPanel decides all four states. */}
      <div className="relative mt-8 h-40 overflow-hidden">
        <TrendPanel
          series={chartSeries}
          loading={loading}
          fillOpacity={0.16}
          decorate={nothingYet}
          onActive={scrub.onActive}
        />
        {spanDays >= 1 && (
          <span className="absolute right-0 bottom-2 z-10 font-mono text-muted-foreground text-xs tracking-wide">
            {spanDays}D
          </span>
        )}
      </div>
    </div>
  );
}
