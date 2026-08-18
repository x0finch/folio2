import { cn } from "@folio/ui";

// 「一行里最多占 max 格,**计数尾巴自己算一格**」——装得下就全平铺,装不下就前 max-1 个 + `+N`。
// 关键在尾巴占一格:否则 4 个折成 `a b c +1` 比全显还宽,折叠就白折了。
// 账户行的 tag(#a #b +2)与代币抽屉平台行的账户(@a @b +2)共用这一条,两处不会各自漂移。
//
// total 单独传:调用方手里可能只有「前几名」而非全量(如 SourceGroup.topAccounts 只带前 3,
// 真实总数在 count 上),这时按 total 判折叠、按 items 取平铺项。
export function collapseToSlots<T>(
  items: readonly T[],
  max: number | undefined,
  total: number = items.length,
): { shown: T[]; overflow: number } {
  if (max == null || total <= max) return { shown: [...items], overflow: 0 };
  const shown = items.slice(0, max - 1);
  return { shown, overflow: total - shown.length };
}

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
      // 换行只给**不折叠**的那份(抽屉传全部 tag):挤在一行会把每个名字截成省略号,得能换行。
      // 折叠的那份(账户行传 max)反过来必须单行 —— 换行会让行高随 tag 数变,列表参差不齐;
      // 它靠 `+N` 控制个数、靠每个 tag 的 truncate 控制长度。
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs",
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
