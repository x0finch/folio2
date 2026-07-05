import { cn } from "@folio/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

// 代币/账户 logo 头像:有图显图,失败回退首字母圆标。复刻 folio-old/components/ui/logo-avatar。
const sizes = {
  sm: { avatar: "size-6", fallback: "text-[10px]" },
  md: { avatar: "size-8", fallback: "text-sm" },
  lg: { avatar: "size-12", fallback: "text-base" },
} as const;

export function LogoAvatar({
  src,
  fallback,
  alt,
  size = "md",
  className,
}: {
  src?: string | null;
  fallback: string;
  alt?: string;
  size?: keyof typeof sizes;
  className?: string;
}) {
  const s = sizes[size];
  return (
    <Avatar className={cn("shrink-0", s.avatar, className)}>
      <AvatarImage src={src || ""} alt={alt ?? ""} className="rounded-full object-contain" />
      <AvatarFallback className={cn("font-medium text-muted-foreground", s.fallback)}>
        {fallback?.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
