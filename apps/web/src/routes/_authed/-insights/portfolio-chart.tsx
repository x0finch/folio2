import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@folio/ui";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useFormatter, useLocale, useTranslations } from "use-intl";
import type { HistoryPoint } from "../../../lib/history";
import { usePreferCurrency } from "../../../lib/hooks/use-prefer-currency";
import { formatMoney } from "../../../lib/i18n/format-number";

const DAY_MS = 86_400_000;
/** 图框高度。骨架必须同值,后到的图才不会把下面顶开。 */
export const CHART_FRAME = "h-[220px] w-full";

export function PortfolioChart({ series }: { series: HistoryPoint[] }) {
  const t = useTranslations("Overview");
  const format = useFormatter();
  const { currency, rate } = usePreferCurrency();
  const locale = useLocale();

  // app 级组合(原则 #11):组合 @folio/ui 的 ChartContainer + recharts 原语;配色走 shadcn
  // 图表 token(--chart-1),不写死颜色。ChartContainer 据 config 注入 --color-total。
  const chartConfig = {
    total: { label: t("portfolioValue"), color: "var(--chart-1)" },
  } satisfies ChartConfig;

  // 紧凑金额(轴):$13.1K,避免过宽裁切;tooltip 用完整精度。按偏好币种换算 + locale 感知。
  const axisUsd = (n: number) => formatMoney(n, { rate, locale, currency, compact: true });
  const fullUsd = (n: number) => formatMoney(n, { rate, locale, currency });
  const fullDateTime = (ms: number) =>
    format.dateTime(new Date(ms), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  // 自适应 X 轴刻度:整段跨度 < 2 天 → 「时:分」(同日多次同步可区分);更长 → 「月 日」。
  const spanMs = series.length > 1 ? series[series.length - 1].t - series[0].t : 0;
  const axisX = (ms: number) =>
    spanMs < 2 * DAY_MS
      ? format.dateTime(new Date(ms), { hour: "2-digit", minute: "2-digit" })
      : format.dateTime(new Date(ms), { month: "short", day: "numeric" });

  return (
    <ChartContainer config={chartConfig} className={CHART_FRAME}>
      <AreaChart data={series} margin={{ left: 12, right: 16, top: 8, bottom: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
          tickFormatter={axisX}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickMargin={4}
          tickFormatter={axisUsd}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => fullDateTime(Number(payload?.[0]?.payload?.t))}
              formatter={(value) => fullUsd(Number(value))}
            />
          }
        />
        <Area
          dataKey="total"
          type="monotone"
          stroke="var(--color-total)"
          fill="var(--color-total)"
          fillOpacity={0.2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
