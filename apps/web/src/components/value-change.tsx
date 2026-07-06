import { cn } from "@folio/ui";
import { useDisplayValue } from "../lib/hooks/use-display-value";

// 涨跌上色的变化值(复刻 folio-old/components/features/value-change)。
// format="currency":金额变化(按偏好币种换算,如总额 24h 价值差);format="percent":百分比(比率,不换算)。
// 涨绿跌红,0/空 → muted 短横。
export function ValueChange({
  value,
  format = "currency",
  className,
}: {
  value: number | null | undefined;
  format?: "currency" | "percent";
  className?: string;
}) {
  const money = useDisplayValue();
  if (typeof value !== "number" || Number.isNaN(value) || value === 0) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }
  const positive = value > 0;
  const text = format === "percent" ? `${Math.abs(value).toFixed(2)}%` : money(Math.abs(value));
  return (
    <span
      className={cn(
        positive ? "text-green-600 dark:text-green-500" : "text-red-600 dark:text-red-500",
        className,
      )}
    >
      {positive ? "+" : "−"}
      {text}
    </span>
  );
}
