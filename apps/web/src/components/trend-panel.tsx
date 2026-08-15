import { type ChartConfig, ChartContainer } from "@folio/ui";
import { Area, AreaChart, YAxis } from "recharts";
import { useTranslations } from "use-intl";
import type { HistoryPoint } from "../lib/history";
import { TrendEmpty } from "./trend-empty";
import { ValueTrendChart } from "./value-trend-chart";

// 价值趋势区的**状态机**:一个点数不够 / 还在取数 / 什么都还没有 / 真有数据,四种情况在这里一次
// 判完,调用方只给原料。
//
// **为什么要有这一层。** 这个判断原来在三处各写一遍(首页 hero、资产抽屉、账户抽屉),而且三处
// 各写各的门槛 —— 漏一处就是一半的界面留白,那正是 #444 的形状。更糟的是当时还得靠一条**源码扫描
// 测试**去盯「每处都写了 `series.length >= 2 ?` 而不是 `&&`」:需要拿正则看源码来保证一致性,
// 说明这件事本来就该收成一个组件。收进来之后那条扫描测试可以删掉 —— 一处代码不需要被扫。
//
// 默认值按**抽屉**那两处配好(topMargin 56 / fillOpacity 0.14),于是它们各自只剩一行;hero 的
// 排版不同(上留白更大把折线压到下半区),自己覆盖。
const CHART_TOP_MARGIN = 56;
const CHART_FILL_OPACITY = 0.14;

// 「还什么都没有」时的装饰趋势:曲折上扬,纯背景纹样 —— 实线平滑曲线(type=natural,非折线)、
// 不吃指针、无 hover/tooltip。值仅用于形状(轴全隐藏)。
//
// **它只在没有任何持仓、总额为 0 时出现**,由调用方给 `decorate` 决定。一旦屏幕上有真实数字,
// 这条线就会跟它矛盾(它恒向上,而那个数完全可能在跌),那时必须走 TrendEmpty 说明原因 —— 它
// 与真折线肉眼分不出来,拿它充行情就是在编数据。
const DEMO_TREND = [
  0.12, 0.16, 0.13, 0.2, 0.17, 0.24, 0.28, 0.23, 0.31, 0.27, 0.35, 0.41, 0.37, 0.45, 0.52, 0.48,
  0.55, 0.51, 0.6, 0.67, 0.63, 0.72, 0.82, 0.92,
].map((total, t) => ({ t, total }));

function DecorativeTrend({ topMargin }: { topMargin: number }) {
  const t = useTranslations("Overview");
  const config = {
    total: { label: t("portfolioValue"), color: "var(--pos)" },
  } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="pointer-events-none absolute inset-0 h-full w-full">
      <AreaChart data={DEMO_TREND} margin={{ top: topMargin, right: 8, bottom: 8, left: 8 }}>
        <defs>
          <linearGradient id="hero-fill-demo" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-total)" stopOpacity={0.12} />
            <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Area
          dataKey="total"
          type="natural"
          stroke="var(--color-total)"
          strokeWidth={2}
          strokeOpacity={0.45}
          fill="url(#hero-fill-demo)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

export function TrendPanel({
  series,
  loading = false,
  topMargin = CHART_TOP_MARGIN,
  fillOpacity = CHART_FILL_OPACITY,
  decorate = false,
}: {
  series: readonly HistoryPoint[];
  /** 还在取数 —— 此时什么都不渲染,否则会闪一下空态文案再被图盖掉。 */
  loading?: boolean;
  topMargin?: number;
  fillOpacity?: number;
  /**
   * 「什么都还没有」→ 画装饰纹样而不是说明原因。**只有在屏幕上没有任何真实数字可被它矛盾时
   * 才允许开**(hero:无持仓且总额 0)。判据留给调用方 —— 那是它的领域知识,不是这一层的。
   */
  decorate?: boolean;
}) {
  // 还在取数时什么都不画:不能先闪装饰线/空态文案,再被真图盖掉。
  if (loading) return <TrendEmpty loading />;
  // 一个点连不成线。门槛只在这里写一次。
  if (series.length >= 2) {
    // 图单独一层裁溢出:调用方的容器往往还浮着名称/金额层,不能被 overflow-hidden 切掉
    // (账户抽屉左上角那个铅笔角标就吃过这个)。图本身是 absolute inset-0,套一层不改几何。
    return (
      <div className="absolute inset-0 overflow-hidden">
        <ValueTrendChart series={[...series]} topMargin={topMargin} fillOpacity={fillOpacity} />
      </div>
    );
  }
  if (decorate) return <DecorativeTrend topMargin={topMargin} />;
  return <TrendEmpty loading={loading} />;
}
