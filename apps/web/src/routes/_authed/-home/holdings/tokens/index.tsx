import { SharedLayoutBg } from "@folio/ui";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { buildStack } from "@/components/avatar-stack";
import type { Holding } from "@/lib/core/portfolio";
import { useHomeViewState } from "@/routes/_authed/-home/view-state";
import { TokenRowContent } from "./token-row";
import { TokenSheet } from "./token-sheet";

// Holdings aggregated by token; rows open the detail drawer. Dust (< DUST_THRESHOLD) folds into a footer toggle.
const DUST_THRESHOLD = 1; // USD
// Below this holding count nothing folds: the list is already short.
const MIN_FOLD_COUNT = 10;

// Rows use <TokenRowContent> (same as the account drawer's spot section); multi-source holdings
// stack source logos beside the name and amounts sum across sources.
function RowContent({ h, gainPending }: { h: Holding; gainPending: boolean }) {
  return (
    <TokenRowContent
      item={{
        logo: h.token.logo,
        name: h.token.name,
        symbol: h.token.symbol,
        amount: h.totalAmount,
        value: h.totalValue,
        // The home path always carries gain24h (null = not computable); pass it through.
        gain24h: h.gain24h,
      }}
      // Where this token is spread (one slot per account x platform). Sorted by value via
      // buildStack, no dust drop (`dust: 0`): a small source is still a source, and with the dust
      // toggle on a full-dust list would end up empty.
      sources={buildStack(
        h.sources.map((s) => ({
          logo: s.platform.logo,
          name: s.platform.name,
          k: `${s.account.id}|${s.platform.id}`,
          magnitude: s.value,
        })),
        0,
      )}
      gainPending={gainPending}
    />
  );
}

// Row button: must be a direct DOM child of SharedLayoutBg (component elements don't receive its
// injected relative/onMouseEnter), so not wrapped in <HoldingRow>; className gets "relative" merged in.
const rowClass = "w-full rounded-xl px-3 py-3 text-left";

export function TokenHoldings({
  holdings,
  gainPending = false,
}: {
  holdings: Holding[];
  /** PnL still loading: value renders, the delta slot shows a small skeleton. */
  gainPending?: boolean;
}) {
  const t = useTranslations("Overview");
  const [showDust, setShowDust] = useState(false);
  // The open drawer's token lives in component state (HomeViewStateProvider); opening is a plain setState.
  const { token: selectedKey, setToken } = useHomeViewState();
  // An unrecognized key (token gone after a portfolio switch) means closed. The fallback must live
  // here: the two instances (main list / custom tab) each hold their own holdings.
  const selected = holdings.find((h) => h.key === selectedKey) ?? null;
  // Under MIN_FOLD_COUNT holdings nothing folds; otherwise dust rows go into the toggle.
  const canFold = holdings.length >= MIN_FOLD_COUNT;
  // Dust = small value and little PnL that day: a sold-out token has value 0 but may have just lost
  // 3000, and folding it would hide that.
  const isDust = (h: Holding) =>
    h.totalValue < DUST_THRESHOLD && Math.abs(h.gain24h?.amount ?? 0) < DUST_THRESHOLD;
  const main = canFold ? holdings.filter((h) => !isDust(h)) : holdings;
  const dust = canFold ? holdings.filter(isDust) : [];
  const rows = showDust ? [...main, ...dust] : main;

  return (
    <>
      <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
        {rows.map((h) => (
          <button key={h.key} type="button" onClick={() => setToken(h.key)} className={rowClass}>
            <RowContent h={h} gainPending={gainPending} />
          </button>
        ))}
      </SharedLayoutBg>
      {/* Dust toggle: a standalone button outside SharedLayoutBg's sliding pill. Expanded: a compact
          floating chip, sticky at the bottom of the list viewport so long lists can be collapsed from
          anywhere. Collapsed: a full-width row in the list flow. */}
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
      <TokenSheet
        holding={selected}
        open={selected != null}
        onOpenChange={(o) => {
          if (!o) setToken(undefined);
        }}
      />
    </>
  );
}
