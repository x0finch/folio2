import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage, cn } from "@folio/ui";

// 叠放的平台/链 logo 小圆(beUI AvatarGroup):缺 logo 回退首字母、title 显名;超 max 以 +N 收尾。
// AvatarImage 垫 bg-logo-bg 恒亮实底 —— 透明 logo 边角不漏 fallback 字母,且不随主题翻转。
// 代币行(多源平台叠标)与详情抽屉(账户跨多链)共用。
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
  // k:稳定唯一 key(name 可能重复,如同一平台多账户);缺省回退 name。
  items: { logo?: string; name: string; k?: string }[];
  size?: keyof typeof SIZES;
  max?: number;
  className?: string;
}) {
  const s = SIZES[size];
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <AvatarGroup className={cn("shrink-0 -space-x-1", className)}>
      {shown.map((a) => (
        <Avatar key={a.k ?? a.name} title={a.name} className={s.avatar}>
          <AvatarImage src={a.logo} alt="" className="bg-logo-bg" />
          <AvatarFallback className={s.text}>{a.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
      ))}
      {extra > 0 ? (
        <AvatarGroupCount className={cn(s.avatar, s.text)}>+{extra}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}
