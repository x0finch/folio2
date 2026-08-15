import { cn } from "@folio/ui";
import type { ReactNode } from "react";

// 统计小件:muted xs label + mono 加粗值。hero 三指标与 perp 权益条共用
// (code review:此前两处 byte-for-byte 重复,排版调整会漏一处)。
export function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div>
      <div className="mb-0.5 text-muted-foreground text-xs">{label}</div>
      <div className={cn("font-mono font-semibold text-sm tabular-nums", className)}>{value}</div>
    </div>
  );
}
