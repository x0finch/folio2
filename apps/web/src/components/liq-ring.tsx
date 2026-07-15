import { cn, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { type LiqRiskState, liqRisk, markPx, type PerpPositionView } from "../lib/perp";

// 强平风险环(H5 #120,概念稿四轮定稿:温度计→血条→环):~20px SVG 圆环把「距强平多远」
// 压缩成 占比(安全余量 clamp 到满环)+ 三态色。色语义唯一(rev5):安全 = muted 灰(不庆祝),
// 警告 = --warn,危险 = --neg 且仅此态外发光 —— 红绿留给盈亏,报警才引人注意。
// 开仓/标记/强平/余量% 走 hover popover 渐进披露(触屏点按;NoteIndicator 同款交互)。
// liqRisk 为 null(无强平价等)时由父级降级为文本,不渲染本组件。

const R = 8; // viewBox 24 内的环半径
const CIRCUMFERENCE = 2 * Math.PI * R;

const arcClass: Record<LiqRiskState, string> = {
  safe: "text-muted-foreground",
  warn: "text-warn",
  danger: "text-neg",
};

function RiskArc({ margin, state }: { margin: number; state: LiqRiskState }) {
  const arc = Math.min(Math.max(margin, 0), 1) * CIRCUMFERENCE;
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
      // 发光只在危险态:token 引用(--neg),深浅主题各自成立。
      style={state === "danger" ? { filter: "drop-shadow(0 0 3px var(--neg))" } : undefined}
    >
      <circle cx="12" cy="12" r={R} fill="none" strokeWidth="3.4" className="stroke-muted" />
      <circle
        cx="12"
        cy="12"
        r={R}
        fill="none"
        strokeWidth="3.4"
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

export function LiqRing({ position }: { position: PerpPositionView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const [open, setOpen] = useState(false);
  const risk = liqRisk(position);
  if (risk == null || position.liquidationPx == null) return null;
  const mark = markPx(position);

  return (
    // 打开时抬 z-50:beUI popover 面板 root 内绝对定位、不 portal(同 NoteIndicator 的接线注释)。
    <Popover trigger="hover" onOpenChange={setOpen} className={cn("shrink-0", open && "z-50")}>
      <PopoverTrigger>
        <span className="flex items-center" role="img" aria-label={t("safetyMargin")}>
          <RiskArc margin={risk.margin} state={risk.state} />
        </span>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex min-w-36 flex-col gap-1 p-1">
          <DetailRow
            label={t("safetyMargin")}
            value={`${Math.round(risk.margin * 100)}%`}
            className={cn("font-medium", risk.state !== "safe" && arcClass[risk.state])}
          />
          <DetailRow label={t("entry")} value={usd(position.entryPx)} />
          {mark != null && <DetailRow label={t("mark")} value={usd(mark)} />}
          <DetailRow label={t("liq")} value={usd(position.liquidationPx)} className="text-neg" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
