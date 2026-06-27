import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@folio/ui";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { HistoryPoint } from "../lib/history";

// app 级组合(原则 #11):组合 @folio/ui 的 ChartContainer + recharts 原语;配色走 shadcn
// 图表 token(--chart-1),不写死颜色。ChartContainer 据 config 注入 --color-total。
const chartConfig = {
  total: { label: "Portfolio value", color: "var(--chart-1)" },
} satisfies ChartConfig;

const DAY_MS = 86_400_000;

// 轴上的紧凑金额(避免 "$13,109" 过宽把 Y 轴标签裁掉):$13.1K。
const fmtAxisUsd = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  });

// tooltip 里给完整精度金额与完整日期时间(不丢信息)。
const fmtFullUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtFullDateTime = (t: number) =>
  new Date(t).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function PortfolioChart({ series }: { series: HistoryPoint[] }) {
  // 自适应 X 轴刻度:整段跨度 < 2 天 → 显示「时:分」(同日多次同步可区分);更长 → 显示「月 日」。
  const spanMs = series.length > 1 ? series[series.length - 1].t - series[0].t : 0;
  const fmtAxisX = (t: number) =>
    spanMs < 2 * DAY_MS
      ? new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <ChartContainer config={chartConfig} className="h-[220px] w-full">
      <AreaChart data={series} margin={{ left: 12, right: 16, top: 8, bottom: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
          tickFormatter={fmtAxisX}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickMargin={4}
          tickFormatter={fmtAxisUsd}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => fmtFullDateTime(Number(payload?.[0]?.payload?.t))}
              formatter={(value) => fmtFullUsd(Number(value))}
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
