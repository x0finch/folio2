import { cn } from "@folio/ui";

// popover 明细行:muted label + tabular 值(LiqRing / 仓位 pill / 权益条弹层共用)。
export function DetailRow({
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
