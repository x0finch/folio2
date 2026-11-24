import { cn, Popover, PopoverContent, PopoverTrigger, Separator } from "@folio/ui";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { Sensitive } from "@/components/sensitive";
import type { PerpPositionView } from "@/lib/core/account-view";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { useHoverPopover } from "@/lib/hooks/use-hover-popover";
import type { LiqRisk, LiqRiskState } from "./liq-risk";

function DetailRow({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", className)}>{value}</span>
    </div>
  );
}

// Liquidation risk ring: a ~20px SVG ring showing the safety margin (clamped to a full ring) with
// three-state color (--pos / --warn / --neg). Details open in a beUI Popover (hover / focus), with
// z-lift, goo backing and direction from useHoverPopover (shared with NoteIndicator). `risk` is
// computed by the parent, which already uses it to decide whether to render.

const R = 8; // ring radius within the 24 viewBox
const STROKE_WIDTH = 3.4; // track and arc share it (separate values would look like two rings)
const CIRCUMFERENCE = 2 * Math.PI * R;
// Minimum visible red arc in the danger state: a tiny fill collapses into a sliver / round-cap dot.
const MIN_DANGER_FILL = 0.08;

const arcClass: Record<LiqRiskState, string> = {
  safe: "text-pos",
  warn: "text-warn",
  danger: "text-neg",
};

function RiskArc({ fill, state }: { fill: number; state: LiqRiskState }) {
  const clamped = Math.min(Math.max(fill, 0), 1);
  // Danger: already at/past liquidation (fill=0) -> full red ring; other danger -> at least MIN_DANGER_FILL.
  const shown =
    state === "danger" ? (clamped === 0 ? 1 : Math.max(clamped, MIN_DANGER_FILL)) : clamped;
  const arc = shown * CIRCUMFERENCE;
  return (
    // Both circles are fill=none so the sliding pill shows through; on row hover the track switches
    // to --background so it doesn't blend into the bg-muted pill (the group is on the row wrapper).
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

// position: entry price and position-level margin info share this popover, one detail entry per row.
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
        {/* Focusable button: keyboard focus opens it (hover mode applies to focus too). */}
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
        {/* Top: position margin info (mode / used); divider; bottom: price / risk (margin / entry / mark / liq). */}
        <div className="flex min-w-36 flex-col gap-1 p-1">
          {position.leverageType && (
            <DetailRow
              label={t("marginMode")}
              value={position.leverageType.charAt(0).toUpperCase() + position.leverageType.slice(1)}
            />
          )}
          {/* Used margin is the user's money: masked; entry / mark / liq are market prices: unmasked. */}
          <DetailRow
            label={t("marginUsedAmount")}
            value={<Sensitive>{usd(position.marginUsed)}</Sensitive>}
          />
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
