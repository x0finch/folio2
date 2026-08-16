import { cn, Skeleton } from "@folio/ui";
import { useDisplayValue } from "../../../../lib/hooks/use-display-value";
import { signedUsd } from "../../../../lib/i18n/format-number";

// 「没有这个数」的占位。em dash 而不是空白 —— 空白会被读成「还没加载出来」,而这里是
// 「问过了,答不上来」。与 hero 各个 Stat 格子的空态同形。
export const NO_VALUE = "—";

// 增量小字的三态与配色(ADR 0040)。`<ValueDelta>`(行内小字)与账户/代币抽屉头(大字)共用 ——
// 两处字号、布局都不同,但「什么时候显示 `—`、0 涂什么颜色」必须是同一套。
//   · `undefined` —— 这个位置本来就不该有增量(归档行:数字冻在封存那一刻)。调用方整行省略,不进这里。
//   · `null` —— 该有,但算不出(缺 24 小时前的基准 / 最近的基准太旧)。
//   · `0` —— 算出来确实没涨没跌,是一条真实结论。
// null 与 0 都**不带方向**,走中性色 —— 给 0 涂上涨/下跌的颜色是在暗示一个不存在的方向,
// 而给「不知道」涂颜色更糟。
export function deltaTone(delta: number | null): string {
  if (delta == null || delta === 0) return "text-muted-foreground";
  return delta > 0 ? "text-pos" : "text-neg";
}

/** 24h 盈亏位的小骨架 —— 行内 / hero 增量 / best-worst 三处同形。宽度锁在典型一行增量。 */
export function GainSkeleton() {
  return <Skeleton className="inline-block h-4 w-28 rounded-full" />;
}

// 全站统一的「价值 + 单符号增量」块(H5 #120):上市值,下 `{±}$Δ P%` 单前置符号、
// 同色 --pos/--neg。代币行(24h)/ 永续仓位(uPnL)/ DeFi 协议行(24h 聚合)/ 账户行 / 账户抽屉头共用 ——
// 语义不同、形状统一。pct 缺 → 只显 Δ。价值为负(DeFi 净负债)→ --neg。
// align:行右侧列用 "right"(默认,shrink 防挤压);抽屉头等左对齐场景用 "left"。
//
// **`delta` 是三态,不是「有没有」**(ADR 0040):
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
