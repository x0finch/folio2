import { LogoAvatar } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { formatNumber } from "../lib/format-number";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { AssetSheet } from "./asset-sheet";

// 按代币聚合的持仓列表(v2:LogoAvatar + 名称/symbol / 数量 · 价格 / 市值 · 24h;点击行 → 详情抽屉)。
// 小额(< DUST_THRESHOLD)折叠进「N 项小额」footer。
const DUST_THRESHOLD = 1; // USD;待定阈值

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

function HoldingRow({ h, onOpen }: { h: Holding; onOpen: (h: Holding) => void }) {
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
    <button
      type="button"
      onClick={() => onOpen(h)}
      className="flex w-full items-center gap-3 rounded-md border-border/60 border-b px-2 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40"
    >
      <LogoAvatar src={h.token.logo} fallback={h.token.symbol} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{h.token.name}</span>
          <span className="text-muted-foreground text-xs uppercase">{h.token.symbol}</span>
        </div>
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
    </button>
  );
}

export function TokenHoldings({ holdings }: { holdings: Holding[] }) {
  const t = useTranslations("Overview");
  const [showDust, setShowDust] = useState(false);
  const [selected, setSelected] = useState<Holding | null>(null);
  const [open, setOpen] = useState(false);
  const onOpen = (h: Holding) => {
    setSelected(h);
    setOpen(true);
  };
  const main = holdings.filter((h) => h.totalValue >= DUST_THRESHOLD);
  const dust = holdings.filter((h) => h.totalValue < DUST_THRESHOLD);

  return (
    <div className="flex flex-col">
      {main.map((h) => (
        <HoldingRow key={h.key} h={h} onOpen={onOpen} />
      ))}
      {dust.length > 0 &&
        (showDust ? (
          dust.map((h) => <HoldingRow key={h.key} h={h} onOpen={onOpen} />)
        ) : (
          <button
            type="button"
            onClick={() => setShowDust(true)}
            className="px-2 py-3 text-left text-muted-foreground text-sm hover:text-foreground"
          >
            {t("smallHoldings", { n: dust.length })} ▸
          </button>
        ))}
      <AssetSheet holding={selected} open={open} onOpenChange={setOpen} />
    </div>
  );
}
