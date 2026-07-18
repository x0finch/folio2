import { cn } from "@folio/ui";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { signedUsd } from "../lib/signed-usd";

// 全站统一的「价值 + 单符号增量」块(H5 #120):上市值,下 `{±}$Δ P%` 单前置符号、
// 同色 --pos/--neg。代币行(24h)/ 永续仓位(uPnL)/ DeFi 协议行(24h 聚合)/ 账户行 / 账户抽屉头共用 ——
// 语义不同、形状统一。delta 缺或为 0 → 只显价值;pct 缺 → 只显 Δ。价值为负(DeFi 净负债)→ --neg。
// align:行右侧列用 "right"(默认,shrink 防挤压);抽屉头等左对齐场景用 "left"。
export function ValueDelta({
  value,
  delta,
  pct,
  align = "right",
  className,
}: {
  value: number;
  delta?: number | null;
  pct?: number | null;
  align?: "left" | "right";
  className?: string;
}) {
  const usd = useDisplayValue();
  return (
    <div className={cn(align === "right" ? "shrink-0 text-right" : "text-left", className)}>
      <div className={cn("font-medium tabular-nums", value < 0 && "text-neg")}>{usd(value)}</div>
      {delta != null && delta !== 0 && (
        <div className={cn("text-xs tabular-nums", delta > 0 ? "text-pos" : "text-neg")}>
          {signedUsd(usd, delta)}
          {pct != null && ` ${Math.abs(pct).toFixed(2)}%`}
        </div>
      )}
    </div>
  );
}
