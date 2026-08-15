import { cn, Popover, PopoverContent, PopoverTrigger, Separator } from "@folio/ui";
import { useTranslations } from "use-intl";
import { useDisplayValue } from "../../../../lib/hooks/use-display-value";
import { useHoverPopover } from "../../../../lib/hooks/use-hover-popover";
import type { LiqRisk, LiqRiskState, PerpPositionView } from "../../../../lib/perp";
import { DetailRow } from "./detail-row";

// 强平风险环(H5 #120,概念稿定稿:温度计→血条→环):~20px SVG 圆环把「距强平多远」
// 压缩成 占比(安全余量 clamp 到满环)+ 三态色:安全 --pos、警告 --warn、危险 --neg,无发光。
// 明细(余量%/开仓/标记/强平)走 beUI Popover(hover / 键盘 focus)渐进披露;抬 z、隐垫底、
// 动态方向等调用侧行为统一取自 useHoverPopover(与 NoteIndicator 共用)。
// risk 由父级算好传入(父级本就用它决定渲染与否,不重复推导)。

const R = 8; // viewBox 24 内的环半径
const STROKE_WIDTH = 3.4; // 底环与彩弧同宽(分开写会悄悄变成两个环)
const CIRCUMFERENCE = 2 * Math.PI * R;
// 危险态非零填充的最小可见红弧:极小 fill 的 strokeDasharray 会缩成 sliver / round-cap 小点,
// 保底一小段,读作「余量极低」。(穿仓另行给满环,见下。)
const MIN_DANGER_FILL = 0.08;

const arcClass: Record<LiqRiskState, string> = {
  safe: "text-pos",
  warn: "text-warn",
  danger: "text-neg",
};

function RiskArc({ fill, state }: { fill: number; state: LiqRiskState }) {
  const clamped = Math.min(Math.max(fill, 0), 1);
  // 危险态:穿仓(fill=0,已到/越过强平)→ 满红环,明确「已穿仓」的终态;其余危险 → 至少 MIN 段红弧。
  const shown =
    state === "danger" ? (clamped === 0 ? 1 : Math.max(clamped, MIN_DANGER_FILL)) : clamped;
  const arc = shown * CIRCUMFERENCE;
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

// position:开仓价 + 仓位级保证金信息(模式/单仓保证金)一并进本弹层——一行一个明细入口。
export function LiqRing({ risk, position }: { risk: LiqRisk; position: PerpPositionView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const pop = useHoverPopover();
  return (
    <Popover
      trigger="hover"
      side={pop.side}
      onOpenChange={pop.onOpenChange}
      className={cn("shrink-0", pop.rootClassName)}
    >
      <PopoverTrigger>
        {/* 可聚焦 button:键盘 Tab → focus 即开(hover 模式对 focus 同样生效)。 */}
        <button
          ref={pop.measureRef}
          type="button"
          aria-label={t("safetyMargin")}
          className="flex cursor-pointer items-center outline-none"
        >
          <RiskArc fill={risk.fill} state={risk.state} />
        </button>
      </PopoverTrigger>
      <PopoverContent>
        {/* 上:仓位保证金信息(模式/已用);分隔;下:价格/风险(余量/开仓/标记/强平)。 */}
        <div className="flex min-w-36 flex-col gap-1 p-1">
          {position.leverageType && (
            <DetailRow
              label={t("marginMode")}
              value={position.leverageType.charAt(0).toUpperCase() + position.leverageType.slice(1)}
            />
          )}
          <DetailRow label={t("marginUsedAmount")} value={usd(position.marginUsed)} />
          <Separator className="my-1" />
          <DetailRow
            label={t("safetyMargin")}
            value={`${Math.round(risk.distance * 100)}%`}
            className={cn("font-medium", arcClass[risk.state])}
          />
          <DetailRow label={t("entry")} value={usd(position.entryPx)} />
          <DetailRow label={t("mark")} value={usd(risk.mark)} />
          <DetailRow label={t("liq")} value={usd(risk.liquidationPx)} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
