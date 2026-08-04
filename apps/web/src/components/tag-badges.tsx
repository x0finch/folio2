import { cn } from "@folio/ui";

// Tag 展示徽章(ADR 0034 / #351):**低调纯文字 `#name`**(muted),不常驻描边/底色 —— 平时只是一串
// 井号名,单独 hover 某一个才浮出圆底。`#` 是纯展示前缀,永不入库(存的一直是纯名字)。
// 账户行传 max=2 折叠成 `+N`;抽屉传全部(max 省略 = 不折叠)。
// hoverClassName:调用方按底衬调 —— 列表行本身 hover 时是 muted 高亮 pill,tag 的圆底得改用
// bg-background 才不与之糊成一片(同 ConnectorBadge 的既有做法)。

export interface TagBadgeItem {
  id: string;
  name: string;
}

const chipClass =
  "rounded-full px-1.5 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-muted";

export function TagBadges({
  tags,
  max,
  className,
  hoverClassName,
}: {
  tags: TagBadgeItem[];
  max?: number;
  className?: string;
  hoverClassName?: string;
}) {
  if (tags.length === 0) return null;
  const shown = max != null ? tags.slice(0, max) : tags;
  const overflow = tags.length - shown.length;
  return (
    <span className={cn("flex min-w-0 items-center gap-0.5", className)}>
      {shown.map((tg) => (
        <span key={tg.id} className={cn(chipClass, "min-w-0 truncate", hoverClassName)}>
          #{tg.name}
        </span>
      ))}
      {overflow > 0 && (
        <span className={cn(chipClass, "shrink-0", hoverClassName)}>+{overflow}</span>
      )}
    </span>
  );
}
