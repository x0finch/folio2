import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@folio/ui";
import { useId } from "react";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { useFormatter } from "use-intl";
import type { HistoryPoint } from "../../../../lib/history";
import { useDisplayValue } from "../../../../lib/hooks/use-display-value";

// 价值趋势面积图(主页净值 hero + 资产抽屉单币价值共用):折线随涨跌走 --pos/--neg,渐变填充,轴全隐,
// hover 出 tooltip(时间 + 价值)。绝对定位垫底用(inset-0),调用方套 relative + overflow-hidden 容器。
//
// 关键:四周留 margin 给 recharts 的 active dot 余量 —— 折线贴容器边(尤其接近底部)时,圆点半径会溢出
// 绘图区被 overflow-hidden 裁掉;各边留 8px 让贴边圆点仍完整(top 由调用方按需加大,把折线压到下半区)。
// gradient id 用 useId 保唯一:hero 与抽屉可同时在 DOM,写死 id 会撞、串色。
export function ValueTrendChart({
  series,
  topMargin = 8,
  fillOpacity = 0.16,
}: {
  series: HistoryPoint[];
  topMargin?: number;
  fillOpacity?: number;
}) {
  const usd = useDisplayValue();
  const format = useFormatter();
  const gradientId = `value-trend-${useId().replace(/:/g, "")}`;
  if (series.length < 2) return null;
  const up = (series.at(-1)?.total ?? 0) >= (series[0]?.total ?? 0);
  const config = {
    total: { label: "", color: up ? "var(--pos)" : "var(--neg)" },
  } satisfies ChartConfig;
  const fullDateTime = (ms: number) =>
    format.dateTime(new Date(ms), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <ChartContainer config={config} className="absolute inset-0 h-full w-full">
      <AreaChart data={series} margin={{ top: topMargin, right: 8, bottom: 8, left: 8 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-total)" stopOpacity={fillOpacity} />
            <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="t" hide />
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <ChartTooltip
          cursor={{ stroke: "var(--border-2)", strokeDasharray: "3 3" }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => fullDateTime(Number(payload?.[0]?.payload?.t))}
              formatter={(value) => usd(Number(value))}
            />
          }
        />
        <Area
          dataKey="total"
          type="monotone"
          // baseValue 钉死 dataMin:填充恒在折线下方。默认 "auto" 在 domain 跨 0(账户可有负值历史点)时
          // 取基线 0 → 负值段填充翻到线上方(阴影反向);dataMin 消除反向。全正序列下 domain=[dataMin,dataMax]
          // 中 0 本就不在域内、auto 已等于 dataMin,故 hero / 资产抽屉观感不变。
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
