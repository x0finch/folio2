import type { ReactNode } from "react";

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3 px-3">
      <span className="text-muted-foreground text-xs uppercase tracking-widest">{title}</span>
    </div>
  );
}

// Sections ordered by subtotal descending (custom-tab view): the biggest on top, empty ones
// (count=0) dropped. Generic: callers pass each section's content; this only sorts and adds headers.

export interface OverviewSection {
  key: string;
  title: string; // eyebrow heading
  subtotal: number; // section value subtotal (sort key)
  count: number; // item count; 0 = empty, dropped
  content: ReactNode;
}

// Non-finite subtotals sort as 0, so a NaN can't silently fall through to the key tiebreak.
const subtotalKey = (n: number): number => (Number.isFinite(n) ? n : 0);

// Drop empty sections, sort by subtotal descending (ties broken by key for a stable order).
export function orderSections<T extends { key: string; subtotal: number; count: number }>(
  sections: T[],
): T[] {
  return sections
    .filter((s) => s.count > 0)
    .sort(
      (a, b) => subtotalKey(b.subtotal) - subtotalKey(a.subtotal) || a.key.localeCompare(b.key),
    );
}

export function SectionList({ sections }: { sections: OverviewSection[] }) {
  const ordered = orderSections(sections);
  if (ordered.length === 0) return null;
  return (
    <div className="flex flex-col gap-6">
      {ordered.map((s, i) => (
        <div key={s.key} className="flex flex-col gap-3">
          {/* The first (largest) section omits its eyebrow: it is already the default focus. */}
          {i > 0 && <SectionHeader title={s.title} />}
          {s.content}
        </div>
      ))}
    </div>
  );
}
