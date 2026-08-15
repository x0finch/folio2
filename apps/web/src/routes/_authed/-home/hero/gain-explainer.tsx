import { cn, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import type { ReactNode } from "react";
import { useFormatter, useTranslations } from "use-intl";
import type { Gain } from "../../../../lib/gain-24h";
import { useDisplayValue } from "../../../../lib/hooks/use-display-value";
import { useHoverPopover } from "../../../../lib/hooks/use-hover-popover";
import { signedUsd } from "../../../../lib/signed-usd";

// 24h 盈亏的解释弹层(#445)。
//
// **它存在的理由是一个看起来像 bug 的正确行为**:金额与百分比来自两套计算(金额 = 各段价值变动
// 之和;百分比 = 各段收益率**连乘**),所以你动过仓的那天,金额 ÷ 期初 ≠ 百分比。
// 例:期初 10 万赚 5,000(+5%),中午加仓到 21 万又赚 1 万(+4.76%)—— 金额 +1.5 万、收益率 +10.0%,
// 而 1.5 万 ÷ 10 万 = 15%。用户一除就对不上,与其让他纳闷,不如摊开。
//
// 摊到多细:**只摊你动过手的地方**。没动手的连续时段在算法那侧已经合并成一段(见 gain-24h 的
// mergeSegments)—— 逐段列出来是一串价格在慢慢爬,没有信息量,而切口本身才是要解释的东西。
// 于是没买卖过就只有一行、除法也刚好对得上;买卖过才多几行,而那正是需要解释的时候。
//
// hover 开(手机上点一下,beUI Popover 的 trigger="hover" 在触屏上即 tap)。抬 z / 关闭态隐 goo
// 垫底 / 动态方向都取自 useHoverPopover,与 NoteIndicator、LiqRing 同一套行为。
export function GainExplainer({
  gain,
  className,
  children,
}: {
  gain: Gain;
  className?: string;
  children: ReactNode;
}) {
  const t = useTranslations("Overview");
  const format = useFormatter();
  const usd = useDisplayValue();
  const pop = useHoverPopover();

  const when = (ms: number) =>
    format.dateTime(new Date(ms), { hour: "numeric", minute: "2-digit" });
  const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
  // 多段才需要解释「为什么不能直接除」—— 单段时金额 ÷ 期初就等于百分比,摆算式反而添乱。
  const multi = gain.segments.length > 1;

  return (
    <Popover
      trigger="hover"
      side={pop.side}
      onOpenChange={pop.onOpenChange}
      className={cn("shrink-0", pop.rootClassName)}
    >
      <PopoverTrigger>
        <button
          ref={pop.measureRef}
          type="button"
          aria-label={t("gainExplainTitle")}
          className={cn("cursor-help outline-none", className)}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="max-h-72 min-w-[16rem] overflow-y-auto text-xs">
          <div className="font-medium">{t("gainExplainTitle")}</div>
          <p className="mt-1 text-muted-foreground">{t("gainExplainWhat")}</p>

          <div className="mt-3 flex flex-col gap-1.5">
            {gain.segments.map((seg) => (
              <div key={seg.from} className="flex flex-col gap-0.5">
                {/* 这一段是被你的动作切开的 → 明说,否则用户看不懂为什么在这儿断开。 */}
                {seg.openedByChange && (
                  <div className="text-[0.65rem] text-muted-foreground">
                    ↑ {t("gainExplainChanged")}
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3 tabular-nums">
                  <span className="text-muted-foreground">
                    {when(seg.from)} → {when(seg.to)}
                  </span>
                  <span className={seg.gain > 0 ? "text-pos" : seg.gain < 0 ? "text-neg" : ""}>
                    {signedUsd(usd, seg.gain)}
                    {seg.pct != null ? ` ${pct(seg.pct)}` : ""}
                  </span>
                </div>
                <div className="text-[0.65rem] text-muted-foreground tabular-nums">
                  {t("gainExplainOpenValue", { value: usd(seg.openValue) })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-baseline justify-between gap-3 border-border border-t pt-2 tabular-nums">
            <span className="text-muted-foreground">{t("gainExplainTotal")}</span>
            <span className={gain.amount > 0 ? "text-pos" : gain.amount < 0 ? "text-neg" : ""}>
              {signedUsd(usd, gain.amount)}
            </span>
          </div>
          {gain.pct != null && (
            <div className="flex items-baseline justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground">{t("gainExplainReturn")}</span>
              <span>{pct(gain.pct)}</span>
            </div>
          )}
          {/* 只有多段时才会出现「除不通」,那时才解释。 */}
          {multi && <p className="mt-2 text-muted-foreground">{t("gainExplainWhyNot")}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
