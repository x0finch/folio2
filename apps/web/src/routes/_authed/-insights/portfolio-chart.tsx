import { LineChart, LineChartPlot, LineChartTooltip } from "@folio/ui";
import { useFormatter, useLocale, useTranslations } from "use-intl";
import { formatMoney } from "@/lib/core/format-number";
import type { HistoryPoint } from "@/lib/core/history";
import { useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";
import { usePreferCurrency } from "@/lib/hooks/use-prefer-currency";

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const HIDDEN_VALUE = "•••";

export function PortfolioChart({
  series,
  height,
}: {
  series: readonly HistoryPoint[];
  /** Plot height in px; omitted = the chart's own default. */
  height?: number;
}) {
  const t = useTranslations("Overview");
  const format = useFormatter();
  const { currency, rate } = usePreferCurrency();
  const locale = useLocale();
  const { hidden } = useBalancePrivacy();

  const axisUsd = (n: number) => formatMoney(n, { rate, locale, currency, compact: true });
  const fullUsd = (n: number) => formatMoney(n, { rate, locale, currency });

  // The chart keys points by their label, so labels must be unique: add the time under two days
  // and the year past one.
  const spanMs = series.length > 1 ? series[series.length - 1].t - series[0].t : 0;
  const labelOf = (ms: number) =>
    format.dateTime(new Date(ms), {
      month: "short",
      day: "numeric",
      ...(spanMs < 2 * DAY_MS ? { hour: "2-digit", minute: "2-digit" } : {}),
      ...(spanMs > YEAR_MS ? { year: "2-digit" } : {}),
    });

  return (
    <LineChart
      label={t("portfolioValue")}
      variant="area"
      categories={series.map((p) => labelOf(p.t))}
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
      <LineChartPlot height={height} />
      <LineChartTooltip />
    </LineChart>
  );
}
