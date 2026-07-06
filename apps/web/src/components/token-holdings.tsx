import { LogoAvatar } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { formatNumber } from "../lib/format-number";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { AssetSheet } from "./asset-sheet";
import { ValueChange } from "./value-change";

// 按代币聚合的持仓列表(复刻 folio-old:LogoAvatar + 名称/symbol + 值 + 涨跌;点击行 → 详情抽屉)。
// 小额(< DUST_THRESHOLD)折叠进「N 项小额」footer。
const DUST_THRESHOLD = 1; // USD;待定阈值

function HoldingRow({ h, onOpen }: { h: Holding; onOpen: (h: Holding) => void }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
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
        <span className="text-muted-foreground text-xs">{scale}</span>
      </div>
      <div className="text-right">
        <div className="font-medium">{usd(h.totalValue)}</div>
        <div className="flex items-center justify-end gap-2 text-muted-foreground text-xs">
          {h.change24h != null && <ValueChange value={h.change24h} format="percent" />}
          {h.totalAmount != null && (
            <span>
              {formatNumber(h.totalAmount)} {h.token.symbol}
            </span>
          )}
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
