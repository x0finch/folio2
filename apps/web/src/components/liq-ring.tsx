import { cn, HoverPopover } from "@folio/ui";
import { useTranslations } from "use-intl";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import type { LiqRisk, LiqRiskState } from "../lib/perp";

// 强平风险环(H5 #120,概念稿定稿:温度计→血条→环):~20px SVG 圆环把「距强平多远」
// 压缩成 占比(安全余量 clamp 到满环)+ 三态色:安全 --pos、警告 --warn、危险 --neg,无发光。
// 明细(余量%/开仓/标记/强平)走 <HoverPopover> 渐进披露(hover / 键盘 focus;方向与垫底层
// 处理都在共享件里)。risk 由父级算好传入(父级本就用它决定渲染与否,不重复推导)。

const R = 8; // viewBox 24 内的环半径
const STROKE_WIDTH = 3.4; // 底环与彩弧同宽(分开写会悄悄变成两个环)
const CIRCUMFERENCE = 2 * Math.PI * R;

const arcClass: Record<LiqRiskState, string> = {
  safe: "text-pos",
  warn: "text-warn",
  danger: "text-neg",
};

function RiskArc({ margin, state }: { margin: number; state: LiqRiskState }) {
  const arc = Math.min(Math.max(margin, 0), 1) * CIRCUMFERENCE;
  return (
    // 环心恒透明(两个 circle 都 fill=none,滑块/底色可透过);行 hover 时底环换 --background,
    // 不与 bg-muted 滑块融为一体(group 在行包装层)。
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r={R}
        fill="none"
        strokeWidth={STROKE_WIDTH}
        className="stroke-muted transition-colors group-hover:stroke-background"
      />
      <circle
        cx="12"
        cy="12"
        r={R}
        fill="none"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={`${arc} ${CIRCUMFERENCE}`}
        transform="rotate(-90 12 12)"
        className={cn("stroke-current", arcClass[state])}
      />
    </svg>
  );
}

function DetailRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", className)}>{value}</span>
    </div>
  );
}

export function LiqRing({ risk, entryPx }: { risk: LiqRisk; entryPx: number }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  return (
    <HoverPopover
      content={
        <div className="flex min-w-36 flex-col gap-1 p-1">
          <DetailRow
            label={t("safetyMargin")}
            value={`${Math.round(risk.margin * 100)}%`}
            className={cn("font-medium", arcClass[risk.state])}
          />
          <DetailRow label={t("entry")} value={usd(entryPx)} />
          <DetailRow label={t("mark")} value={usd(risk.mark)} />
          <DetailRow label={t("liq")} value={usd(risk.liquidationPx)} className="text-neg" />
        </div>
      }
    >
      {/* 可聚焦 button:键盘 Tab → focus 即开(review #6;hover 模式对 focus 同样生效)。 */}
      <button
        type="button"
        aria-label={t("safetyMargin")}
        className="flex cursor-pointer items-center outline-none"
      >
        <RiskArc margin={risk.margin} state={risk.state} />
      </button>
    </HoverPopover>
  );
}
