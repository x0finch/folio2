import { LineChart, LineChartPlot, LineChartTooltip } from "@folio/ui";
import { useFormatter, useLocale, useTranslations } from "use-intl";
import { Sensitive } from "@/components/sensitive";
import { formatMoney } from "@/lib/core/format-number";
import type { HistoryPoint } from "@/lib/core/history";
import { useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";
import { usePreferCurrency } from "@/lib/hooks/use-prefer-currency";

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const HIDDEN_VALUE = "•••";

export function PortfolioChart({ series }: { series: HistoryPoint[] }) {
  const t = useTranslations("Overview");
  const format = useFormatter();
  const { currency, rate } = usePreferCurrency();
  const locale = useLocale();
  const { hidden } = useBalancePrivacy();

  const axisUsd = (n: number) => formatMoney(n, { rate, locale, currency, compact: true });
  const fullUsd = (n: number) => formatMoney(n, { rate, locale, currency });

  // The chart keys points by their label and drops a repeated one, so labels must be unique: add
  // the time under two days and the year past one.
  const spanMs = series.length > 1 ? series[series.length - 1].t - series[0].t : 0;
  const labelOf = (ms: number, withTime: boolean) =>
    format.dateTime(new Date(ms), {
      month: "short",
      day: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
      ...(spanMs > YEAR_MS ? { year: "2-digit" } : {}),
    });
  // Two points can still share a local day (a sampled min/max pair, or the live point just after
  // a UTC-day close), and the later one would vanish from the chart. The last point of a day keeps
  // the plain label, so the axis ticks stay short; the earlier ones get their time.
  const dayLabels = series.map((p) => labelOf(p.t, spanMs < 2 * DAY_MS));
  const lastOfDay = new Map(dayLabels.map((label, i) => [label, i]));
  const categories = series.map((p, i) =>
    lastOfDay.get(dayLabels[i]) === i ? dayLabels[i] : labelOf(p.t, true),
  );

  return (
    <LineChart
      label={t("portfolioValue")}
      variant="area"
      categories={categories}
      series={[
        {
          id: "total",
          name: t("portfolioValue"),
          color: "var(--chart-1)",
          values: series.map((p) => p.total),
        },
      ]}
      // Axis ticks are scale, not amounts, so only the readout is hidden.
      formatValue={hidden ? () => HIDDEN_VALUE : fullUsd}
      formatTick={axisUsd}
    >
      <LineChartPlot />
      {/* `formatValue` covers what a screen reader hears; on screen the amount goes through
          <Sensitive> like every other one. */}
      <LineChartTooltip>
        {hidden
          ? ({ category, rows }) => (
              <span className="block min-w-36">
                <span className="mb-2 block font-medium text-xs">{category}</span>
                {rows.map((row) => (
                  <span key={row.id} className="flex items-center justify-between gap-4 text-xs">
                    <span className="text-muted-foreground">{row.name}</span>
                    {row.value !== null && <Sensitive>{fullUsd(row.value)}</Sensitive>}
                  </span>
                ))}
              </span>
            )
          : undefined}
      </LineChartTooltip>
    </LineChart>
  );
}
