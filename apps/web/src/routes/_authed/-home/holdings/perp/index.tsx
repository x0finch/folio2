import { LogoAvatar, Separator, SharedLayoutBg } from "@folio/ui";
import { useTranslations } from "use-intl";
import { AccountName } from "@/components/account-name";
import { Sensitive } from "@/components/sensitive";
import type { PerpPositionView, PerpView } from "@/lib/core/account-view";
import { formatNumber, signedUsd } from "@/lib/core/format-number";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { Stat } from "@/routes/_authed/-home/hero/stat";
import { ValueDelta } from "@/routes/_authed/-home/holdings/value-delta";
import { LiqRing } from "./liq-ring";
import { liqRisk, pnlPct } from "./liq-risk";

// Perp holdings detail, shared by the overview "Perps" tab and the account drawer. Row-style like
// token rows; red/green only mean PnL, --warn/--neg alerts live only on LiqRing, and the direction pill is neutral gray.

interface PlatformBadge {
  name: string;
  logo?: string;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="text-muted-foreground text-xs uppercase tracking-widest">{title}</span>
    </div>
  );
}

// Neutral gray chip (e.g. `3x Long`); on row hover it switches to --background so it doesn't blend into the slider.
function NeutralChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-px font-medium text-muted-foreground text-xs tabular-nums transition-colors group-hover:bg-background">
      {children}
    </span>
  );
}

// side is capitalized as-is; Long/Short are not translated.
const sideLabel = (side: "long" | "short") => side.charAt(0).toUpperCase() + side.slice(1);

function PerpRowContent({ p }: { p: PerpPositionView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const risk = liqRisk(p);
  return (
    <div className="flex w-full items-center gap-3">
      {/* Direction badge above; amount + coin share a row with the liquidation ring. */}
      <div className="flex flex-col items-start gap-1">
        <NeutralChip>
          {p.leverage != null ? `${p.leverage}x ` : ""}
          {sideLabel(p.side)}
        </NeutralChip>
        <div className="flex items-center gap-2">
          <span className="font-medium tabular-nums">
            {/* Masks the position size, keeps the coin; entry price is a market price, unmasked. */}
            <Sensitive>{formatNumber(Math.abs(p.size))}</Sensitive> {p.coin}
          </span>
          {risk ? (
            <LiqRing risk={risk} position={p} />
          ) : (
            // No liquidation price (e.g. some cross-margin cases): the ring degrades to a muted entry-price text.
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("entry")} {usd(p.entryPx)}
            </span>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1" />
      <ValueDelta value={p.positionValue} delta={p.unrealizedPnl} pct={pnlPct(p)} />
    </div>
  );
}

function PerpAccountBody({ view }: { view: PerpView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const { equity, positions } = view;
  const totalUpnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const marginRatio =
    equity && equity.accountValue > 0 ? equity.totalMarginUsed / equity.accountValue : null;
  return (
    <>
      {equity && (
        <div className="flex flex-wrap gap-x-10 gap-y-2 px-3">
          {/* Equity / uPnL / withdrawable / notional are the user's money: masked; margin ratio and leverage are ratios: kept. */}
          <Stat
            label={t("accountEquity")}
            value={<Sensitive>{usd(equity.accountValue)}</Sensitive>}
          />
          <Stat
            label={t("upnl")}
            value={<Sensitive>{signedUsd(usd, totalUpnl)}</Sensitive>}
            className={totalUpnl > 0 ? "text-pos" : totalUpnl < 0 ? "text-neg" : undefined}
          />
          {marginRatio != null && (
            <Stat label={t("marginRatio")} value={`${Math.round(marginRatio * 100)}%`} />
          )}
          <Stat
            label={t("withdrawable")}
            value={<Sensitive>{usd(equity.withdrawable)}</Sensitive>}
          />
          <Stat label={t("notional")} value={<Sensitive>{usd(equity.totalNtlPos)}</Sensitive>} />
          {equity.accountValue > 0 && (
            <Stat
              label={t("accountLeverage")}
              value={`${(equity.totalNtlPos / equity.accountValue).toFixed(2)}x`}
            />
          )}
        </div>
      )}
      {positions.length > 0 && (
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {positions.map((p) => (
            <div key={p.coin} className="group rounded-xl px-3 py-3 has-[[data-state=open]]:z-20">
              <PerpRowContent p={p} />
            </div>
          ))}
        </SharedLayoutBg>
      )}
    </>
  );
}

// Perp section (single account, drawer): eyebrow header + equity bar + position rows. hideHeader:
// the drawer's tab already titles it.
export function PerpPositions({ view, hideHeader }: { view: PerpView; hideHeader?: boolean }) {
  const t = useTranslations("Overview");
  return (
    <section className="flex flex-col gap-3">
      {!hideHeader && <SectionHeader title={t("perpSectionTitle")} />}
      <PerpAccountBody view={view} />
    </section>
  );
}

export interface PerpSectionItem {
  id: string;
  view: PerpView;
  platform?: PlatformBadge;
  accountLabel?: string;
}

// Perp section (overview "Perps" tab): one block per account, by account equity descending.
export function PerpPositionsList({ items }: { items: PerpSectionItem[] }) {
  const sorted = [...items].sort(
    (a, b) => (b.view.equity?.accountValue ?? 0) - (a.view.equity?.accountValue ?? 0),
  );
  return (
    <section className="flex flex-col gap-6">
      {sorted.map((it, i) => (
        <div key={it.id} className="flex flex-col gap-3">
          {i > 0 && (
            <Separator className="mt-2 mb-5 h-0 border-border border-t border-dashed bg-transparent" />
          )}
          <div className="flex items-center gap-2.5 px-3">
            {it.platform && (
              <LogoAvatar size="sm" src={it.platform.logo} fallback={it.platform.name} />
            )}
            <div className="min-w-0">
              <div className="truncate font-medium text-sm">
                {it.platform?.name ?? it.accountLabel}
              </div>
              {it.platform && it.accountLabel && (
                <AccountName name={it.accountLabel} className="text-muted-foreground text-xs" />
              )}
            </div>
          </div>
          <PerpAccountBody view={it.view} />
        </div>
      ))}
    </section>
  );
}
