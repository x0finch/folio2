import {
  DonutChart,
  DonutChartCenter,
  DonutChartLegend,
  DonutChartPlot,
  type DonutSegment,
} from "@folio/ui";
import { useLocale, useTranslations } from "use-intl";
import { Sensitive } from "@/components/sensitive";
import { formatMoney } from "@/lib/core/format-number";
import { useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";
import { usePreferCurrency } from "@/lib/hooks/use-prefer-currency";
import { type AllocSlice, OTHERS_KEY } from "./allocation";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
const HIDDEN_VALUE = "•••";

export function AllocationPie({ slices }: { slices: AllocSlice[] }) {
  const t = useTranslations("Insights");
  const { currency, rate } = usePreferCurrency();
  const locale = useLocale();
  const { hidden } = useBalancePrivacy();
  const usd = (n: number) => formatMoney(n, { rate, locale, currency });

  // The ring leaves out empty slices, so an all-zero set has nothing to draw either.
  if (slices.every((s) => s.value <= 0)) {
    return <p className="text-muted-foreground text-sm">{t("noData")}</p>;
  }

  const segments: DonutSegment[] = slices.map((s, i) => ({
    id: s.key,
    name: s.key === OTHERS_KEY ? t("others") : s.label,
    color: COLORS[i % COLORS.length],
    value: s.value,
  }));

  return (
    // Amounts are hidden under balance privacy; shares stay.
    <DonutChart segments={segments} formatValue={hidden ? () => HIDDEN_VALUE : usd}>
      <div className="grid items-center gap-12 sm:grid-cols-[minmax(0,16rem)_1fr]">
        <DonutChartPlot>
          <DonutChartCenter />
        </DonutChartPlot>
        <DonutChartLegend
          renderValue={(segment) => (
            <span className="flex items-baseline gap-4">
              <span className="text-muted-foreground text-xs">
                {Math.round(segment.share * 100)}%
              </span>
              <span className="w-24 text-right font-medium text-sm">
                <Sensitive>{usd(segment.value)}</Sensitive>
              </span>
            </span>
          )}
        />
      </div>
    </DonutChart>
  );
}
