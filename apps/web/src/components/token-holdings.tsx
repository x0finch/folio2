import { LogoAvatar } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { useUsd } from "./holdings-sections";
import { ValueChange } from "./value-change";

// 按代币聚合的持仓列表(复刻 folio-old 资产行:LogoAvatar + 名称/symbol + 值 + 涨跌)。
// 多来源行(sources>1)可点开"查看更多"看各持有点;单来源行静态。小额折叠进「N 项小额」footer。
const DUST_THRESHOLD = 1; // USD;待定阈值

function chevron(open: boolean) {
  return (
    <span
      className={`inline-block text-muted-foreground text-xs transition-transform ${open ? "rotate-90" : ""}`}
    >
      ▸
    </span>
  );
}

function HoldingRow({ h }: { h: Holding }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  const [open, setOpen] = useState(false);
  const expandable = h.sources.length > 1;
  const chains = h.sources.filter(
    (s) => s.platform.id.startsWith("eip155:") || s.platform.id.startsWith("chain:"),
  ).length;
  const scale =
    chains > 0
      ? t("chainsAndSources", { chains, sources: h.sources.length })
      : t("sourcesOnly", { sources: h.sources.length });

  const inner = (
    <>
      <span className="w-3 shrink-0">{expandable ? chevron(open) : null}</span>
      <LogoAvatar src={h.token.logo} fallback={h.token.symbol} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{h.token.name}</span>
          <span className="text-muted-foreground text-xs uppercase">{h.token.symbol}</span>
        </div>
        <span className="text-muted-foreground text-xs">
          {scale}
          {expandable && !open && <span className="ml-2">· {t("viewMore")}</span>}
        </span>
      </div>
      <div className="text-right">
        <div className="font-medium">{usd(h.totalValue)}</div>
        <div className="flex items-center justify-end gap-2 text-muted-foreground text-xs">
          {h.change24h != null && <ValueChange value={h.change24h} format="percent" />}
          {h.totalAmount != null && (
            <span>
              {h.totalAmount} {h.token.symbol}
            </span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="border-border/60 border-b last:border-b-0">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-muted/40"
        >
          {inner}
        </button>
      ) : (
        <div className="flex w-full items-center gap-3 px-2 py-3">{inner}</div>
      )}
      {expandable && open && (
        <div className="flex flex-col gap-1.5 pb-3 pl-12 pr-2">
          {h.sources.map((s) => (
            <div
              key={`${s.account.id}|${s.platform.id}`}
              className="flex items-center gap-3 text-sm"
            >
              <span className="flex-1">
                <span className="text-muted-foreground">{s.platform.name}</span>
                <span className="mx-1 text-muted-foreground">·</span>
                <span>{s.account.label}</span>
                {s.isMargin && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t("margin")}
                  </span>
                )}
              </span>
              <span className="text-muted-foreground">{s.amount}</span>
              <span className="w-28 text-right">{usd(s.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TokenHoldings({ holdings }: { holdings: Holding[] }) {
  const t = useTranslations("Overview");
  const [showDust, setShowDust] = useState(false);
  const main = holdings.filter((h) => h.totalValue >= DUST_THRESHOLD);
  const dust = holdings.filter((h) => h.totalValue < DUST_THRESHOLD);
  return (
    <div className="flex flex-col">
      {main.map((h) => (
        <HoldingRow key={h.key} h={h} />
      ))}
      {dust.length > 0 &&
        (showDust ? (
          dust.map((h) => <HoldingRow key={h.key} h={h} />)
        ) : (
          <button
            type="button"
            onClick={() => setShowDust(true)}
            className="px-2 py-3 text-left text-muted-foreground text-sm hover:text-foreground"
          >
            {t("smallHoldings", { n: dust.length })} ▸
          </button>
        ))}
    </div>
  );
}
