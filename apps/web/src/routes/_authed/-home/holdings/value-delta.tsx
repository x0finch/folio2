import { cn, Skeleton } from "@folio/ui";
import { Sensitive } from "@/components/sensitive";
import { signedUsd } from "@/lib/core/format-number";
import { useDisplayValue } from "@/lib/hooks/use-display-value";

// Placeholder for "no number": an em dash, since blank reads as "not loaded yet" while this means "asked, can't answer".
export const NO_VALUE = "—";

// Three states of the delta and their colors, shared by <ValueDelta> and the drawer headers (which
// differ in size but must agree on when to show `—` and how to color 0):
//   - `undefined`: no delta belongs here (archived row: frozen value); callers omit the row.
//   - `null`: should exist but isn't computable (no 24h baseline / baseline too old).
//   - `0`: computed, truly unchanged.
// null and 0 carry no direction and use the neutral color.
export function deltaTone(delta: number | null): string {
  if (delta == null || delta === 0) return "text-muted-foreground";
  return delta > 0 ? "text-pos" : "text-neg";
}

/** Small skeleton for the 24h PnL slot, same shape for row / hero delta / best-worst. */
export function GainSkeleton() {
  return <Skeleton className="inline-block h-4 w-28 rounded-full" />;
}

// Value plus single-prefix delta block (`{±}$Δ P%`), colored --pos/--neg; shared by token / perp /
// DeFi / account rows and drawer headers. Missing pct shows only Δ; a negative value (DeFi net debt)
// is --neg. align: "right" (default, shrinks) for row end columns, "left" for drawer headers.
// `delta` is tri-state: `undefined` omits the row, `null` shows `—`, `0` shows `0` neutral, so
// "unknown" and "unchanged" stay distinguishable.
export function ValueDelta({
  value,
  delta,
  pct,
  align = "right",
  loading = false,
}: {
  value: number;
  delta?: number | null;
  pct?: number | null;
  align?: "left" | "right";
  /** PnL still loading: value renders, the delta slot shows a small skeleton (not the "unknown" dash). */
  loading?: boolean;
}) {
  const usd = useDisplayValue();
  return (
    // select-text: amounts are content and must stay copyable inside the non-selectable row/card button.
    <div className={cn("select-text", align === "right" ? "shrink-0 text-right" : "text-left")}>
      <div className={cn("font-medium tabular-nums", value < 0 && "text-neg")}>
        <Sensitive>{usd(value)}</Sensitive>
      </div>
      {loading ? (
        <div className={cn("mt-1 flex", align === "right" ? "justify-end" : "justify-start")}>
          <GainSkeleton />
        </div>
      ) : (
        delta !== undefined && (
          <div className={cn("text-xs tabular-nums", deltaTone(delta))}>
            {delta === null ? (
              NO_VALUE
            ) : (
              <>
                {/* Masks the delta amount, keeps the percentage. */}
                <Sensitive>{signedUsd(usd, delta)}</Sensitive>
                {pct != null && ` ${Math.abs(pct).toFixed(2)}%`}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
