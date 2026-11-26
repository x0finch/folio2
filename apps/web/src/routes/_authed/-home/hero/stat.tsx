import { cn } from "@folio/ui";
import type { ReactNode } from "react";

// Small stat: muted xs label + bold mono value, shared by the hero's three metrics and the perp equity bar.
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
      <div className="mb-1 text-muted-foreground text-xs">{label}</div>
      <div className={cn("font-mono font-semibold text-sm tabular-nums", className)}>{value}</div>
    </div>
  );
}
