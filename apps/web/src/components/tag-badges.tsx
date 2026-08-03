import { Badge, cn } from "@folio/ui";
import { tagColor } from "../lib/tag-color";

// Tag 展示徽章(ADR 0034):用 beUI 的 AnimatedBadge(= Badge),hash 色只经 style 注入(border + 色点),
// 不改 vendored 件内核。改名时标签文字自带 text-roll 动画。账户行与详情抽屉共用。
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
          <Badge
            key={tg.id}
            size="sm"
            style={{ borderColor: color }}
            icon={<span className="size-1.5 rounded-full" style={{ background: color }} />}
          >
            {tg.name}
          </Badge>
        );
      })}
      {overflow > 0 && (
        <Badge size="sm" showIcon={false}>
          +{overflow}
        </Badge>
      )}
    </span>
  );
}
