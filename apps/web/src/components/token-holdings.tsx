import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
  LogoAvatar,
  SharedLayoutBg,
} from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Holding, HoldingSource } from "../lib/aggregate";
import { formatNumber } from "../lib/format-number";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { AssetSheet } from "./asset-sheet";

// 按代币聚合的持仓列表(v2:LogoAvatar + 名称/symbol / 数量 · 价格 / 市值 · 24h;点击行 → 详情抽屉)。
// hover 高亮由 beUI SharedLayoutBg 的移动滑块承载(行间无分隔线),小额(< DUST_THRESHOLD)折叠进 footer。
const DUST_THRESHOLD = 1; // USD;待定阈值
// 持仓总数 < 此值时不折叠小额:列表本就短,折叠反而多一层交互、没收益。
const MIN_FOLD_COUNT = 10;

// 24h 增值(美元):由当前市值与 24h% 反推 —— 前值 = 市值/(1+pct/100),增值 = 市值 − 前值。
// 与 hero 第二行同语义(增值 + %);无 change24h / 恰好 0 / 前值不合法(≤-100%)→ 不显示。
function dayValueChange(totalValue: number, change24h?: number): number | null {
  if (change24h == null || change24h === 0) return null;
  const factor = 1 + change24h / 100;
  if (factor <= 0) return null;
  return totalValue - totalValue / factor;
}

// 多源代币的平台指示:名称右侧叠放各平台/链 logo 小圆(beUI AvatarGroup;缺 logo 回退首字母、
// title 显示平台名),上限 MAX_PLATFORM_LOGOS,超出以 +N 收尾(AvatarGroupCount)。
// AvatarImage 垫 bg-logo-bg 恒亮实底 —— 透明 logo 边角不漏底下的 fallback 字母,且不随主题翻转。
const MAX_PLATFORM_LOGOS = 3;

function PlatformStack({ sources }: { sources: HoldingSource[] }) {
  const shown = sources.slice(0, MAX_PLATFORM_LOGOS);
  const extra = sources.length - shown.length;
  return (
    <AvatarGroup className="ml-1.5 shrink-0 -space-x-1">
      {shown.map((s) => (
        <Avatar key={s.platform.id} title={s.platform.name} className="size-4">
          <AvatarImage src={s.platform.logo} alt="" className="bg-logo-bg" />
          <AvatarFallback className="text-[8px]">{s.platform.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
      ))}
      {extra > 0 ? (
        <AvatarGroupCount className="size-4 text-[8px]">+{extra}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}

// 行内容:必须是单个 flex 容器 —— SharedLayoutBg 会把 <button> 的 children 塞进一个非 flex 的
// z-10 div(见 app-shell #100),故 flex 布局放这层内层 span,避免图标/名称/数值竖排。
function RowContent({ h }: { h: Holding }) {
  const usd = useDisplayValue();
  const dayValue = dayValueChange(h.totalValue, h.change24h);

  return (
    <div className="flex w-full items-center gap-3">
      <LogoAvatar src={h.token.logo} fallback={h.token.symbol} size="md" />
      <div className="min-w-0 flex-1">
        {/* symbol 不在名称行重复:已跟数量并列。数量 = 各源汇总(多链/多源也合计,见 aggregate)。
            多源(sources > 1)在名称右侧叠放各来源 logo,一眼看出散在哪几处。 */}
        <div className="flex min-w-0 items-center">
          {/* min-w-0 让名称在 flex 里可收缩截断,叠 logo(shrink-0)才不会被挤出框、被价值列盖住。 */}
          <span className="min-w-0 truncate font-medium">{h.token.name}</span>
          {h.sources.length > 1 ? <PlatformStack sources={h.sources} /> : null}
        </div>
        {h.totalAmount != null && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatNumber(h.totalAmount)} {h.token.symbol}
          </span>
        )}
      </div>
      <div className="text-right">
        <div className="font-medium tabular-nums">{usd(h.totalValue)}</div>
        {dayValue != null && (
          // 增值 + %:共用一个前置符号(同源同号),同色。
          <div
            className={`flex items-center justify-end gap-2 text-xs tabular-nums ${
              dayValue > 0 ? "text-pos" : "text-neg"
            }`}
          >
            <span>
              {dayValue > 0 ? "+" : "−"}
              {usd(Math.abs(dayValue))} {Math.abs(h.change24h ?? 0).toFixed(2)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// 行按钮:作为 SharedLayoutBg 的直接 DOM 子元素(组件元素收不到注入的 relative/onMouseEnter,
// 故不能包成 <HoldingRow>);onClick 保留,className 会被 cloneElement 合上 "relative"。
const rowClass = "w-full rounded-xl px-3 py-3 text-left";

export function TokenHoldings({ holdings }: { holdings: Holding[] }) {
  const t = useTranslations("Overview");
  const [showDust, setShowDust] = useState(false);
  const [selected, setSelected] = useState<Holding | null>(null);
  const [open, setOpen] = useState(false);
  const onOpen = (h: Holding) => {
    setSelected(h);
    setOpen(true);
  };
  // 少于 MIN_FOLD_COUNT 个持仓 → 全展开、不折叠;否则小额行按阈值收进 toggle。
  const canFold = holdings.length >= MIN_FOLD_COUNT;
  const main = canFold ? holdings.filter((h) => h.totalValue >= DUST_THRESHOLD) : holdings;
  const dust = canFold ? holdings.filter((h) => h.totalValue < DUST_THRESHOLD) : [];
  const rows = showDust ? [...main, ...dust] : main;

  return (
    <>
      <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
        {rows.map((h) => (
          <button key={h.key} type="button" onClick={() => onOpen(h)} className={rowClass}>
            <RowContent h={h} />
          </button>
        ))}
      </SharedLayoutBg>
      {/* 小额 toggle:独立按钮(不进 SharedLayoutBg 的移动滑块)。
          · 展开态 → 紧凑浮动 chip,sticky 居中钉在列表可视区底部(实底 + 边框 + 阴影),
            长小额列表滚动时随时可见可收起,不必滑到全部代币的最底部。
          · 折叠态 → 行式全宽入口,随列表流。 */}
      {dust.length > 0 &&
        (showDust ? (
          <div className="sticky bottom-3 z-20 flex justify-start">
            <button
              type="button"
              onClick={() => setShowDust(false)}
              className="rounded-full border border-border bg-card px-4 py-2 text-muted-foreground text-sm hover:text-foreground"
            >
              {t("hideSmall")} ▴
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDust(true)}
            className="w-full rounded-xl px-3 py-3 text-left text-muted-foreground text-sm hover:text-foreground"
          >
            {t("smallHoldings", { n: dust.length })} ▸
          </button>
        ))}
      <AssetSheet holding={selected} open={open} onOpenChange={setOpen} />
    </>
  );
}
