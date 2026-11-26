import { cn } from "@folio/ui";

// At most `max` slots per row, and the `+N` tail takes a slot itself: otherwise 4 tags folded to
// `a b c +1` would be wider than showing all. Shared by account-row tags and drawer account lists.
// `total` is separate because callers may only hold the top few items (SourceGroup.topAccounts).
export function collapseToSlots<T>(
  items: readonly T[],
  max: number | undefined,
  total: number = items.length,
): { shown: T[]; overflow: number } {
  if (max == null || total <= max) return { shown: [...items], overflow: 0 };
  const shown = items.slice(0, max - 1);
  return { shown, overflow: total - shown.length };
}

// `#name` is a display-only prefix, never stored. Folding uses collapseToSlots (max=3 shows up to
// 3, else 2 + tail; no max = no folding). The tail is a bare `+N` to match AvatarStack, so it
// needs no i18n.

export interface TagBadgeItem {
  id: string;
  name: string;
}

export function TagBadges({
  tags,
  max,
  className,
}: {
  tags: TagBadgeItem[];
  max?: number;
  className?: string;
}) {
  if (tags.length === 0) return null;
  const { shown, overflow } = collapseToSlots(tags, max);
  return (
    <span
      // Only the unfolded list may wrap (a single line would ellipsize every name); the folded
      // one must stay one line so row height doesn't vary with tag count.
      className={cn(
        "flex min-w-0 items-center gap-2 text-muted-foreground text-xs",
        max == null && "flex-wrap",
        className,
      )}
    >
      {shown.map((tg) => (
        <span key={tg.id} className="min-w-0 truncate">
          #{tg.name}
        </span>
      ))}
      {overflow > 0 && <span className="shrink-0">+{overflow}</span>}
    </span>
  );
}
