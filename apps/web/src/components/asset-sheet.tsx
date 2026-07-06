import { Drawer, LogoAvatar } from "@folio/ui";
import { WalletIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { useUsd } from "./holdings-sections";
import { ValueChange } from "./value-change";

// 资产 drill-down(复刻 folio-old asset-sheet 的抽屉):代币头部 + 各来源明细(链×账户/交易所/perp 保证金)。
// folio2 无每币历史/逐笔数据 → 不做 mini 走势/交易 tab(不造假),只呈现 folio2 有的:总额 + 24h + 各来源。
export function AssetSheet({
  holding,
  open,
  onOpenChange,
}: {
  holding: Holding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      ariaLabel={holding?.token.name}
      className="w-full overflow-y-auto p-6 sm:max-w-md"
    >
      {holding && (
        <>
          <div className="flex items-center gap-3">
            <LogoAvatar src={holding.token.logo} fallback={holding.token.symbol} size="lg" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{holding.token.name}</h2>
              <p className="text-sm uppercase text-muted-foreground">{holding.token.symbol}</p>
            </div>
          </div>

          <div className="mt-4">
            <div className="font-bold text-3xl">{usd(holding.totalValue)}</div>
            <div className="mt-1 flex items-center gap-3 text-muted-foreground text-sm">
              {holding.change24h != null && (
                <ValueChange value={holding.change24h} format="percent" />
              )}
              {holding.totalAmount != null && (
                <span>
                  {holding.totalAmount} {holding.token.symbol}
                </span>
              )}
            </div>
          </div>

          <div className="mt-6">
            <p className="mb-2 font-medium text-muted-foreground text-sm">{t("sourcesTitle")}</p>
            {/* 来源多时列表内滚 + 上下渐隐:外层不滚(挂 list-gradient-blur),内层 overflow;渐隐取抽屉底色。 */}
            <div className="list-gradient-blur [--list-fade:var(--background)]">
              <div className="flex max-h-80 flex-col divide-y divide-border/60 overflow-y-auto">
                {holding.sources.map((s) => (
                  <div
                    key={`${s.account.id}|${s.platform.id}`}
                    className="flex items-center gap-3 py-2.5 text-sm"
                  >
                    {/* Manual 来源不入库/不走 CoinGecko:渲染内置钱包图标(非数据映射)。 */}
                    {s.platform.id === "manual" ? (
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <WalletIcon className="size-3.5" />
                      </span>
                    ) : (
                      <LogoAvatar src={s.platform.logo} fallback={s.platform.name} size="sm" />
                    )}
                    <span className="min-w-0 flex-1">
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
                    <span className="w-28 text-right font-medium">{usd(s.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </Drawer>
  );
}
