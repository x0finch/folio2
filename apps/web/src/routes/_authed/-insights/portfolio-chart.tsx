import { LineChart } from "@folio/ui";
import { useFormatter, useLocale, useTranslations } from "use-intl";
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
  // a UTC-day close): those get their time too, or the later one would vanish from the chart.
  const dayLabels = series.map((p) => labelOf(p.t, spanMs < 2 * DAY_MS));
  const labelCounts = new Map<string, number>();
  for (const label of dayLabels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  const categories = series.map((p, i) =>
    (labelCounts.get(dayLabels[i]) ?? 0) > 1 ? labelOf(p.t, true) : dayLabels[i],
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
    />
  );
}
