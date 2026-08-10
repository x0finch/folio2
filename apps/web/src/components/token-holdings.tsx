import { SharedLayoutBg } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { AssetSheet } from "./asset-sheet";
import { TokenRowContent } from "./token-row";

// 按代币聚合的持仓列表(v2:LogoAvatar + 名称/symbol / 数量 · 价格 / 市值 · 24h;点击行 → 详情抽屉)。
// hover 高亮由 beUI SharedLayoutBg 的移动滑块承载(行间无分隔线),小额(< DUST_THRESHOLD)折叠进 footer。
const DUST_THRESHOLD = 1; // USD;待定阈值
// 持仓总数 < 此值时不折叠小额:列表本就短,折叠反而多一层交互、没收益。
const MIN_FOLD_COUNT = 10;

// 行内容:统一走 <TokenRowContent>(与账户详情抽屉现货区同组件)。多源(sources > 1)在名称右侧
// 叠放各来源 logo,一眼看出散在哪几处;数量 = 各源汇总(多链/多源也合计,见 aggregate)。
function RowContent({ h }: { h: Holding }) {
  return (
    <TokenRowContent
      item={{
        logo: h.token.logo,
        name: h.token.name,
        symbol: h.token.symbol,
        amount: h.totalAmount,
        value: h.totalValue,
        // 主页这条路已接 24h 盈亏(ADR 0040)—— server 算好的分段结果,不再由 change24h 倒推。
        gain24h: h.gain24h ?? null,
      }}
      sources={h.sources.map((s) => ({
        logo: s.platform.logo,
        name: s.platform.name,
        k: `${s.account.id}|${s.platform.id}`,
      }))}
    />
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
