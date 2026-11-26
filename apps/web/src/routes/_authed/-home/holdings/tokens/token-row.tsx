import { LogoAvatar } from "@folio/ui";
import type { ReactNode } from "react";
import { AvatarStack } from "@/components/avatar-stack";
import { Sensitive } from "@/components/sensitive";
import { formatNumber } from "@/lib/core/format-number";
import { ValueDelta } from "@/routes/_authed/-home/holdings/value-delta";

// Shared token holding row content (home Tokens view + account drawer spot section): one flex
// container (SharedLayoutBg wraps children in a non-flex z-10 div). Left: logo + name (optional
// multi-source stack / note aside) + amount·symbol; right: <ValueDelta>. Display only; click and sort are the caller's.
export interface TokenRowItem {
  logo?: string;
  name: string;
  symbol: string;
  amount?: number | null;
  value: number;
  // 24h PnL computed server-side; `null` = not computable -> `—`.
  gain24h?: { amount: number; pct: number | null } | null;
}

export function TokenRowContent({
  item,
  sources,
  aside,
  gainPending = false,
}: {
  item: TokenRowItem;
  // Multi-source (home, across chains/accounts): stacked source logos beside the name; omitted for a single account.
  sources?: { logo?: string; name: string; k: string }[];
  // Extra inline element (e.g. the account drawer's balance-level note indicator).
  aside?: ReactNode;
  /** PnL still loading: value renders, the delta slot shows a small skeleton. */
  gainPending?: boolean;
}) {
  // Pass the three states through: absent = no delta belongs here (omit the row), `null` = `—`,
  // an object = use its amount. `?.amount ?? null` would collapse "shouldn't have" into "can't compute".
  const dayValue = item.gain24h === undefined ? undefined : (item.gain24h?.amount ?? null);
  const dayPct = item.gain24h === undefined ? undefined : (item.gain24h?.pct ?? null);
  return (
    <div className="flex w-full items-center gap-3">
      <LogoAvatar src={item.logo} fallback={item.symbol} size="md" />
      <div className="min-w-0 flex-1">
        {/* min-w-0 lets the name shrink and truncate so stacked logos/aside (shrink-0) aren't pushed out under the value column. */}
        <div className="flex min-w-0 items-center gap-2">
          {/* select-text: the name is content and must stay copyable (the row is a non-selectable button). */}
          <span className="min-w-0 select-text truncate font-medium">{item.name}</span>
          {sources && sources.length > 1 ? <AvatarStack items={sources} /> : null}
          {aside}
        </div>
        {item.amount != null && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {/* Masks the holding amount, keeps the symbol (public token name). */}
            <Sensitive>{formatNumber(item.amount)}</Sensitive> {item.symbol}
          </span>
        )}
      </div>
      <ValueDelta value={item.value} delta={dayValue} pct={dayPct} loading={gainPending} />
    </div>
  );
}
