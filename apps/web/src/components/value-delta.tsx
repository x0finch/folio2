import { cn } from "@folio/ui";
import { useDisplayValue } from "../lib/hooks/use-display-value";

// 全站统一的「价值 + 单符号增量」块(右对齐,H5 #120):上市值,下 `{±}$Δ P%` 单前置符号、
// 同色 --pos/--neg。代币行(24h)/ 永续仓位(uPnL)/ DeFi 协议行(24h 聚合)共用 ——
// 语义不同、形状统一。delta 缺或为 0 → 只显价值;pct 缺 → 只显 Δ。价值为负(DeFi 净负债)→ --neg。
export function ValueDelta({
  value,
  delta,
  pct,
}: {
  value: number;
  delta?: number | null;
  pct?: number | null;
}) {
  const usd = useDisplayValue();
  return (
    <div className="shrink-0 text-right">
      <div className={cn("font-medium tabular-nums", value < 0 && "text-neg")}>{usd(value)}</div>
      {delta != null && delta !== 0 && (
        <div className={cn("text-xs tabular-nums", delta > 0 ? "text-pos" : "text-neg")}>
          {delta > 0 ? "+" : "−"}
          {usd(Math.abs(delta))}
          {pct != null && ` ${Math.abs(pct).toFixed(2)}%`}
        </div>
      )}
    </div>
  );
}
