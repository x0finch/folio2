import { cn } from "@folio/ui";
import { useFormatter } from "use-intl";

// 涨跌上色的变化值(复刻 folio-old/components/features/value-change)。
// format="currency":USD 金额变化(如总额 24h 价值差);format="percent":百分比(如每币 change24h,传 5.2 = 5.2%)。
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
  const f = useFormatter();
  if (typeof value !== "number" || Number.isNaN(value) || value === 0) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }
  const positive = value > 0;
  const text =
    format === "percent"
      ? `${Math.abs(value).toFixed(2)}%`
      : f.number(Math.abs(value), { style: "currency", currency: "USD" });
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
