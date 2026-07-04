import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { AssetCell, useUsd } from "./holdings-sections";

// 按代币聚合的持仓列表(P2):每行一个 Holding(TokenGroup 总额),点开行内展开各持有点。
// 小额(< DUST_THRESHOLD)折叠进「N 项小额」footer,可展开。设计见 evolution/plans/p2-token-aggregation.md。
const DUST_THRESHOLD = 1; // USD;待定阈值(计划已记)

function chevron(open: boolean) {
  return (
    <span
      className={`inline-block text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
    >
      ▸
    </span>
  );
}

function HoldingRow({ h }: { h: Holding }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  const [open, setOpen] = useState(false);
  const chains = h.sources.filter(
    (s) => s.platform.id.startsWith("eip155:") || s.platform.id.startsWith("chain:"),
  ).length;
  const scale =
    chains > 0
      ? t("chainsAndSources", { chains, sources: h.sources.length })
      : t("sourcesOnly", { sources: h.sources.length });
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 py-3 text-left hover:bg-muted/40"
      >
        {chevron(open)}
        <div className="flex-1">
          <AssetCell symbol={h.token.symbol} name={h.token.name} logo={h.token.logo} />
        </div>
        <span className="text-xs text-muted-foreground">{scale}</span>
        <div className="w-32 text-right">
          <div>{usd(h.totalValue)}</div>
          {h.totalAmount != null && (
            <div className="text-xs text-muted-foreground">
              {h.totalAmount} {h.token.symbol}
            </div>
          )}
        </div>
      </button>
      {open && (
        <div className="flex flex-col gap-1 pb-3 pl-8 pr-1">
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
            className="py-3 text-left text-sm text-muted-foreground hover:text-foreground"
          >
            {t("smallHoldings", { n: dust.length })} ▸
          </button>
        ))}
    </div>
  );
}
