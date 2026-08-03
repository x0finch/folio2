import { cn } from "@folio/ui";
import { tagColor } from "../lib/tag-color";

// Tag 展示徽章(ADR 0034):彩色小标(hash 色描边 + 色点),账户行与详情抽屉共用。
// 账户行传 max=2 折叠成 `+N`;抽屉传全部(max 省略 = 不折叠)。颜色只走 --chart-*(tagColor)。

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
  const shown = max != null ? tags.slice(0, max) : tags;
  const overflow = tags.length - shown.length;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {shown.map((tg) => {
        const color = tagColor(tg.id);
        return (
          <span
            key={tg.id}
            className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-muted-foreground text-xs"
            style={{ border: `1px solid ${color}` }}
          >
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="truncate">{tg.name}</span>
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
          +{overflow}
        </span>
      )}
    </span>
  );
}
