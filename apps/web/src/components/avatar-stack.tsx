import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage, cn } from "@folio/ui";
import { ZERO_DISPLAY_USD } from "@/lib/core/account-view";

// Overlapping platform/chain logos (beUI AvatarGroup): missing logos fall back to initials, `max` overflows
// as +N. AvatarImage sits on a solid bg-logo-bg so transparent logos don't show the fallback letter.
const SIZES = {
  sm: { avatar: "size-4", text: "text-[8px]" },
  md: { avatar: "size-6", text: "text-[9px]" },
} as const;

export function AvatarStack({
  items,
  size = "sm",
  max = 3,
  className,
}: {
  // k: stable unique key (names can repeat, e.g. several accounts on one platform); defaults to name.
  items: { logo?: string; name: string; k?: string }[];
  size?: keyof typeof SIZES;
  max?: number;
  className?: string;
}) {
  const s = SIZES[size];
  // Draw nothing for an empty list so callers can pass possibly-empty items directly.
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <AvatarGroup className={cn("shrink-0 -space-x-1", className)}>
      {shown.map((a) => (
        <Avatar key={a.k ?? a.name} title={a.name} className={s.avatar}>
          <AvatarImage src={a.logo} alt="" className="bg-logo-bg" />
          <AvatarFallback className={s.text}>{a.name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      ))}
      {extra > 0 ? (
        <AvatarGroupCount className={cn(s.avatar, s.text)}>+{extra}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}

// Shared assembly for the avatar rows: merge by key, drop near-$0 entries, sort by magnitude
// descending. Callers each turn their row into a StackEntry; the ordering rule lives only here.
export interface StackItem {
  logo?: string;
  name: string;
  k: string;
}

export interface StackEntry {
  k: string; // merge key; granularity is the caller's choice
  name: string; // fallback initial + title when there is no logo
  logo?: string;
  // Sort/dust magnitude; callers compute it (signed spot value / DeFi gross / perp notional), compared by `|magnitude|`.
  magnitude: number;
}

/**
 * @param dust Entries below it are hidden. Defaults to the display threshold; `0` sorts without
 * dropping (source rows must keep a $0.07 chain so the count matches "across 3 platforms").
 */
export function buildStack(
  entries: readonly StackEntry[],
  dust: number = ZERO_DISPLAY_USD,
): StackItem[] {
  const slots = new Map<string, { name: string; logo?: string; magnitude: number }>();
  for (const e of entries) {
    const cur = slots.get(e.k);
    if (!cur) slots.set(e.k, { name: e.name, logo: e.logo, magnitude: e.magnitude });
    else {
      cur.magnitude += e.magnitude;
      // First logo wins: the first-seen row may not have been enriched with one yet.
      cur.logo ??= e.logo;
    }
  }
  return [...slots.entries()]
    .filter(([, s]) => Math.abs(s.magnitude) >= dust)
    .sort(([, a], [, b]) => Math.abs(b.magnitude) - Math.abs(a.magnitude))
    .map(([k, s]) => ({ logo: s.logo, name: s.name, k }));
}
