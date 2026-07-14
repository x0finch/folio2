import { LogoAvatar, SharedLayoutBg } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { formatNumber } from "../lib/format-number";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { AssetSheet } from "./asset-sheet";

// 按代币聚合的持仓列表(v2:LogoAvatar + 名称/symbol / 数量 · 价格 / 市值 · 24h;点击行 → 详情抽屉)。
// hover 高亮由 beUI SharedLayoutBg 的移动滑块承载(行间无分隔线),小额(< DUST_THRESHOLD)折叠进 footer。
const DUST_THRESHOLD = 1; // USD;待定阈值
// 持仓总数 < 此值时不折叠小额:列表本就短,折叠反而多一层交互、没收益。
const MIN_FOLD_COUNT = 10;

// 24h 涨跌(v2 语义色:涨 pos / 跌 neg / 无数据不渲染)。零自定义色,只引用 token。
function Change24h({ value }: { value?: number }) {
  if (value == null || value === 0) return null;
  const positive = value > 0;
  return (
    <span className={positive ? "text-pos" : "text-neg"}>
      {positive ? "+" : "−"}
      {Math.abs(value).toFixed(2)}%
    </span>
  );
}

// 行内容:必须是单个 flex 容器 —— SharedLayoutBg 会把 <button> 的 children 塞进一个非 flex 的
// z-10 div(见 app-shell #100),故 flex 布局放这层内层 span,避免图标/名称/数值竖排。
function RowContent({ h }: { h: Holding }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  // 单一 Token 组才有数量 → 单价 = 市值 / 数量;跨多 Token(桥接家族)退回展示链/源规模。
  const price = h.totalAmount != null && h.totalAmount > 0 ? h.totalValue / h.totalAmount : null;
  const chains = h.sources.filter(
    (s) => s.platform.id.startsWith("eip155:") || s.platform.id.startsWith("chain:"),
  ).length;
  const scale =
    chains > 0
      ? t("chainsAndSources", { chains, sources: h.sources.length })
      : t("sourcesOnly", { sources: h.sources.length });

  return (
    <div className="flex w-full items-center gap-3">
      <LogoAvatar src={h.token.logo} fallback={h.token.symbol} size="md" />
      <div className="min-w-0 flex-1">
        {/* symbol 不在名称行重复:已跟数量并列(单一 Token 组);多 Token 组退回展示链/源规模。 */}
        <div className="truncate font-medium">{h.token.name}</div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {h.totalAmount != null ? `${formatNumber(h.totalAmount)} ${h.token.symbol}` : scale}
        </span>
      </div>
      <div className="text-right">
        <div className="font-medium tabular-nums">{usd(h.totalValue)}</div>
        <div className="flex items-center justify-end gap-2 text-xs tabular-nums">
          {price != null && <span className="text-muted-foreground">{usd(price)}</span>}
          <Change24h value={h.change24h} />
        </div>
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
