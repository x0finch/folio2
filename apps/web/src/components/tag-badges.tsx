import { cn } from "@folio/ui";
import { collapseToSlots } from "../lib/collapse-to-slots";

// Tag 展示徽章(ADR 0034 / #351):**就是一串小字 `#name`**(muted)—— 无描边、无底色,hover 也不出底,
// 纯附注,不抢账户名的注意力。`#` 是纯展示前缀,永不入库(存的一直是纯名字)。
//
// 折叠走共用的 collapseToSlots(与代币抽屉平台行的 `@a @b +2` 同一条规则)。账户行传 max=3 =
// 「3 个以内全显,超过 3 个显 2 个 + 尾巴」;抽屉不传 max = 不折叠。
// 尾巴是裸 `+N`,不带「tags」这个词:前面的 `#` 已说清在数什么,且与同一行 logo 叠标的 `+N` 一致
// (AvatarStack),一个页面不该有两种溢出写法。裸数字无需翻译 → 不进 i18n。

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
      className={cn("flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs", className)}
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
