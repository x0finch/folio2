import { type ChartConfig, ChartContainer, cn, NumberTicker } from "@folio/ui";
import { Area, AreaChart, YAxis } from "recharts";
import { useTranslations } from "use-intl";
import { NO_VALUE } from "../lib/delta-display";
import type { Gain } from "../lib/gain-24h";
import { deriveHeroMetrics, type HoldingLike } from "../lib/hero-stats";
import { downsampleSeries, type HistoryPoint } from "../lib/history";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { signedUsd } from "../lib/signed-usd";
import { GainExplainer } from "./gain-explainer";
import { Stat } from "./stat";
import { TrendEmpty } from "./trend-empty";
import { ValueTrendChart } from "./value-trend-chart";

const DAY_MS = 86_400_000;
// hero 趋势最多展示最近 30 天;更长跨度 + 区间切换属于 Insights(不改共享的 getPortfolioHistory)。
const HERO_WINDOW_DAYS = 30;

// 历史不足(<2 点)时的演示趋势:曲折上扬(有涨有跌但净向上,末点最高),纯背景装饰 ——
// 实线平滑曲线(type=natural,非折线)、不吃指针、无 hover/tooltip。值仅用于形状(轴全隐藏)。
const DEMO_TREND = [
  0.12, 0.16, 0.13, 0.2, 0.17, 0.24, 0.28, 0.23, 0.31, 0.27, 0.35, 0.41, 0.37, 0.45, 0.52, 0.48,
  0.55, 0.51, 0.6, 0.67, 0.63, 0.72, 0.82, 0.92,
].map((total, t) => ({ t, total }));

const fmtPct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

// 净值 hero(H3 #102):趋势图作背景 + 净值/24h/三指标浮于其上(无 Card)。
// 趋势色随涨跌走 --pos/--neg;三指标 best/worst/稳定币占比派生自纯函数 deriveHeroMetrics(已单测)。
export function PortfolioHero({
  series,
  totalUsd,
  gain24h,
  holdings,
  contentClassName,
}: {
  series: HistoryPoint[];
  totalUsd: number;
  // 组合层 24h 盈亏(ADR 0040),由 server 算好 —— **不在这里从曲线上量**。
  // 曲线画的是净值(含充提),这个数剔除了充提,两者本来就不该是同一个;`null` = 算不出。
  gain24h: Gain | null;
  holdings: readonly HoldingLike[];
  // 附加到文案层(数字/指标)的 class —— 只影响文字覆盖层,不动趋势图。默认空,主页不传 → 零影响。
  contentClassName?: string;
}) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();

  // 裁到最近 30 天窗口(以最新快照时刻为基准,与 SSR/客户端一致、不用客户端时钟),
  // 再自适应降采样:粒度随实际数据量走(约 1 天 → 小时级、约 30 天 → 日级),日内多次手动
  // 同步塌缩成"该桶最后一个点",避免刷新频率抖动图形。
  const lastT = series.length > 0 ? series[series.length - 1].t : 0;
  const chartSeries = downsampleSeries(
    series.filter((p) => p.t >= lastT - HERO_WINDOW_DAYS * DAY_MS),
  );
  const hasHistory = chartSeries.length >= 2;
  // 「还什么都没有」—— 只有这一种情况留那条装饰线(见下面 JSX 里的分支)。
  //
  // **判据是「有没有东西」,不是「有没有钱」。** 一开始写的是 `totalUsd > 0`,那样净值为**负**
  // 会掉进装饰线那支:perp 亏穿时屏幕上是「净值 −$X」配一条平滑上扬的绿线,比 0 那种更糟。
  // 而持有价值恰好为 0 的灰尘仓位也仍然是「有仓位」—— 那时该说明原因,不该画背景纹样。
  const nothingYet = holdings.length === 0 && totalUsd === 0;

  // 24h 盈亏(ADR 0040):server 按快照历史 / 账本分段算好 —— 以前这里是「现在总额 − 约 24 小时前
  // 总额」,那是净值差:你充值 10 万,它就显示赚了 10 万。现在剔除了充提与买卖。
  //
  // **这个数与脚下那条曲线不再对得上,那是预期的。** 曲线画的是净值,充值那天它会跳一格而这个数
  // 不动。两个要求没法同时满足(金额要是真赚的钱 / 要剔除资金进出),摊开解释见 #445。
  const dayAbs = gain24h?.amount ?? null;
  const dayPct = gain24h?.pct ?? null;
  // 方向:正/负/持平(0 → 中性,不当作上涨);算不出也走中性。
  const dir = dayAbs == null ? 0 : dayAbs > 0 ? 1 : dayAbs < 0 ? -1 : 0;
  const toneClass =
    dir > 0
      ? "bg-pos-bg text-pos"
      : dir < 0
        ? "bg-neg-bg text-neg"
        : "bg-muted text-muted-foreground";
  const arrow = dir > 0 ? "▲" : dir < 0 ? "▼" : null;
  const pillClass = cn(
    "inline-flex items-center gap-1.5 self-start rounded-full px-2 py-0.5 font-mono font-semibold text-xs",
    toneClass,
  );

  const metrics = deriveHeroMetrics(holdings, totalUsd);
  const spanDays = hasHistory
    ? Math.round((chartSeries[chartSeries.length - 1].t - chartSeries[0].t) / DAY_MS)
    : 0;

  // 拆整数/小数:NumberTicker 内部 Math.round(value) → 若直接 format 整个金额,分位恒为 .00 且整数被进位;
  // 故整数走 ticker(format 取小数点前),小数单独渲染。
  const totalStr = usd(totalUsd);
  const dot = totalStr.lastIndexOf(".");
  const fracPart = dot >= 0 ? totalStr.slice(dot + 1) : null;

  const demoConfig = {
    total: { label: t("portfolioValue"), color: "var(--pos)" },
  } satisfies ChartConfig;

  return (
    <div className="relative min-h-60 overflow-hidden pt-1">
      {hasHistory ? (
        // 上留白把折线压到下半区(topMargin=92);共用 ValueTrendChart(--pos/--neg + tooltip + 各边留白给圆点)。
        <ValueTrendChart series={chartSeries} topMargin={92} />
      ) : nothingYet ? (
        // 空组合(还没加任何账户)才留装饰:此时没有任何数字可被它矛盾,它只是个背景纹样。
        <ChartContainer
          config={demoConfig}
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <AreaChart data={DEMO_TREND} margin={{ top: 92, right: 8, bottom: 8, left: 8 }}>
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
      ) : (
        // **手上有东西,但只有一个观测点** → 说明原因,别画那条编出来的线(#444)。
        // 那条装饰线是平滑上扬的,而它正上方的 pill 完全可能写着 ▼ −1.55% —— 同一屏自相矛盾,
        // 且它看上去与真实折线一模一样(实测确认:肉眼分不出),等于拿假数据充当行情。
        <TrendEmpty loading={false} />
      )}

      {/* 数字层:浮于图上,不吃指针(hover 透传给背景图)。 */}
      <div className={cn("pointer-events-none relative z-10", contentClassName)}>
        <p className="font-medium text-muted-foreground text-xs">{t("totalNetWorth")}</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <div className="flex items-baseline">
            <NumberTicker
              value={totalUsd}
              format={(n) => usd(n).split(".")[0]}
              className="font-mono font-semibold text-4xl tracking-tight sm:text-5xl"
            />
            {fracPart && (
              <span className="font-mono font-semibold text-2xl text-muted-foreground sm:text-3xl">
                .{fracPart}
              </span>
            )}
          </div>
          {/* 算不出(缺 24 小时前的基准)→ `—`,不是留白也不是 0:留白读作「还没加载出来」,
              0 是在断言「今天没涨没跌」。与全站三态口径一致(见 lib/delta-display)。 */}
          {gain24h == null ? (
            <span className={pillClass}>{NO_VALUE}</span>
          ) : (
            // 摊开算式(#445):金额与百分比来自两套计算,你动过仓的那天它们除不通 —— 与其让人
            // 纳闷,不如 hover(手机上点一下)给出各段。这里的 pill 不在可点击行内,包成按钮无冲突。
            <GainExplainer gain={gain24h}>
              <span className={pillClass}>
                {arrow ? `${arrow} ` : ""}
                {dayPct != null ? `${fmtPct(dayPct)} · ` : ""}
                {signedUsd(usd, dayAbs ?? 0)}
              </span>
            </GainExplainer>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-8">
          {/* 「今天赚 / 亏最多的那个仓」—— 按盈亏**金额**取,不按涨跌幅(ADR 0040)。以前只看涨跌幅、
              不看持有多少,于是这两格永远被小仓位的暴涨币占据。金额走 usd() → 跟随展示币种。 */}
          <Stat
            label={t("bestToday")}
            value={
              metrics.best
                ? `${metrics.best.symbol} ${signedUsd(usd, metrics.best.amount)}`
                : NO_VALUE
            }
          />
          <Stat
            label={t("worstToday")}
            value={
              metrics.worst
                ? `${metrics.worst.symbol} ${signedUsd(usd, metrics.worst.amount)}`
                : NO_VALUE
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

      {spanDays >= 1 && (
        <span className="absolute right-0 bottom-2 z-10 font-mono text-muted-foreground text-xs tracking-wide">
          {spanDays}D
        </span>
      )}
    </div>
  );
}
