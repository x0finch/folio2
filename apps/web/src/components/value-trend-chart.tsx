import { type ChartConfig, ChartContainer, ChartTooltip } from "@folio/ui";
import { useEffect, useId } from "react";
import {
  Area,
  AreaChart,
  useActiveTooltipDataPoints,
  useIsTooltipActive,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoryPoint } from "../lib/history";

// 价值趋势面积图(主页净值 hero + 资产抽屉单币价值 + 账户抽屉共用):折线随涨跌走 --pos/--neg,渐变填充,
// 轴全隐。绝对定位垫底用(inset-0),调用方套 relative + overflow-hidden 容器。
//
// **读数不再靠 tooltip 气泡**(片7):横向划过(桌面为悬停)把**上方那个大数字**顶替成该点的值,
// 由调用方拿 `onActive` 自己换。于是气泡原来那两个毛病一起结构性消失 —— 一部分被上层数字压住
// (图容器没层级,数字层与窗口切换都在更高层)、一部分被容器裁掉(那个裁剪是为收住贴边的活跃圆点
// **故意加的**,不能删)。没有气泡,就没有东西会被裁、也没有东西需要抢层级。
//
// **`<ChartTooltip>` 仍然留着,只是渲染空内容。** 探过了:那条竖向指示线就是 tooltip 的 `cursor`,
// 删掉 tooltip 元素连线一起没了;而 `useIsTooltipActive` / `useActiveTooltipDataPoints` 读的是
// 图内部那个 store,要有 tooltip 才会被激活。所以保留元素、`content` 返回 null:线与活跃圆点都在,
// 不产生气泡。
//
// 关键:四周留 margin 给 recharts 的 active dot 余量 —— 折线贴容器边(尤其接近底部)时,圆点半径会溢出
// 绘图区被 overflow-hidden 裁掉;各边留 8px 让贴边圆点仍完整(top 由调用方按需加大,把折线压到下半区)。
// gradient id 用 useId 保唯一:hero 与抽屉可同时在 DOM,写死 id 会撞、串色。

// 把「现在划在哪个点上」报给调用方。必须住在 <AreaChart> 里面 —— 那两个 hook 读的是图自己的 store。
function ActivePointReporter({ onActive }: { onActive: (point: HistoryPoint | null) => void }) {
  const active = useIsTooltipActive();
  const points = useActiveTooltipDataPoints<HistoryPoint>();
  const point = active ? (points?.[0] ?? null) : null;
  useEffect(() => {
    onActive(point);
  }, [point, onActive]);
  return null;
}

export function ValueTrendChart({
  series,
  topMargin = 8,
  fillOpacity = 0.16,
  onActive,
}: {
  series: HistoryPoint[];
  topMargin?: number;
  fillOpacity?: number;
  /** 划动/悬停到某点时回调;松手或移出给 `null`。不传 = 只画图,不读数。 */
  onActive?: (point: HistoryPoint | null) => void;
}) {
  const gradientId = `value-trend-${useId().replace(/:/g, "")}`;
  if (series.length < 2) return null;
  const up = (series.at(-1)?.total ?? 0) >= (series[0]?.total ?? 0);
  const config = {
    total: { label: "", color: up ? "var(--pos)" : "var(--neg)" },
  } satisfies ChartConfig;
  return (
    // touch-pan-y:竖向滑动照常滚页面,横向留给图读数 —— 交给平台仲裁,不自己判方向。
    <ChartContainer config={config} className="absolute inset-0 h-full w-full touch-pan-y">
      <AreaChart data={series} margin={{ top: topMargin, right: 8, bottom: 8, left: 8 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-total)" stopOpacity={fillOpacity} />
            <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="t" hide />
        <YAxis hide domain={["dataMin", "dataMax"]} />
        {/* content 返回 null:不产生气泡,只留 cursor 那条竖线与活跃圆点。 */}
        <ChartTooltip
          cursor={{ stroke: "var(--border-2)", strokeDasharray: "3 3" }}
          content={() => null}
        />
        {onActive && <ActivePointReporter onActive={onActive} />}
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
