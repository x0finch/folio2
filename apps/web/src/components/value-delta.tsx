import { cn } from "@folio/ui";
import { deltaTone, NO_VALUE } from "../lib/delta-display";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { signedUsd } from "../lib/signed-usd";
import { GainSkeleton } from "./skeletons";

// 全站统一的「价值 + 单符号增量」块(H5 #120):上市值,下 `{±}$Δ P%` 单前置符号、
// 同色 --pos/--neg。代币行(24h)/ 永续仓位(uPnL)/ DeFi 协议行(24h 聚合)/ 账户行 / 账户抽屉头共用 ——
// 语义不同、形状统一。pct 缺 → 只显 Δ。价值为负(DeFi 净负债)→ --neg。
// align:行右侧列用 "right"(默认,shrink 防挤压);抽屉头等左对齐场景用 "left"。
//
// **`delta` 是三态,不是「有没有」**(ADR 0040,口径见 lib/delta-display):
//   · `undefined` → 整行省略;· `null` → `—`;· `0` → 显示 `0`,中性色。
// 以前 `null` 和 `0` 都走「不渲染」,于是「不知道」和「没变」在界面上长得一模一样 —— 前者是缺数据、
// 后者是一条真实结论,挤成一种表现之后谁也读不出来。
export function ValueDelta({
  value,
  delta,
  pct,
  align = "right",
  loading = false,
}: {
  value: number;
  delta?: number | null;
  pct?: number | null;
  align?: "left" | "right";
  /** 盈亏还在取 —— 市值照常,增量位走小骨架,不跟「算不出」的破折号混。 */
  loading?: boolean;
}) {
  const usd = useDisplayValue();
  return (
    // select-text:金额是内容,长按要能选中复制。行/卡片是按钮,base 层把它们整体设成不可选
    // (长按不冒蓝色高亮),这里把真正该复制的那两行单独放回来 —— 全站还没有任何复制按钮。
    <div className={cn("select-text", align === "right" ? "shrink-0 text-right" : "text-left")}>
      <div className={cn("font-medium tabular-nums", value < 0 && "text-neg")}>{usd(value)}</div>
      {loading ? (
        <div className={cn("mt-1 flex", align === "right" ? "justify-end" : "justify-start")}>
          <GainSkeleton />
        </div>
      ) : (
        delta !== undefined && (
          <div className={cn("text-xs tabular-nums", deltaTone(delta))}>
            {delta === null ? (
              NO_VALUE
            ) : (
              <>
                {signedUsd(usd, delta)}
                {pct != null && ` ${Math.abs(pct).toFixed(2)}%`}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
