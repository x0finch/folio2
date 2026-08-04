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
  plateClassName,
  fallbackClassName,
}: {
  src?: string | null;
  fallback: string;
  alt?: string;
  size?: keyof typeof sizes;
  className?: string;
  // 图底下那块实底的颜色。默认恒亮白(见下),**放在浅色表面上时传该表面自身的色** —— 否则白盘叠白面
  // 就成了两块白。必须仍是不透明色,不能传 transparent:实底同时挡住底下的 fallback 字母。
  // 注意:改这块时连 className 一起把 Avatar 根也改成同色,否则圆边缘抗锯齿处会漏出根的 bg-muted 暗环。
  plateClassName?: string;
  fallbackClassName?: string; // 首字母回退的字色;根底色随之改时要一起给,否则字与底撞色
}) {
  const s = sizes[size];
  return (
    <Avatar className={cn("shrink-0", s.avatar, className)}>
      {/* bg-logo-bg 恒亮实底:object-contain 的透明边角/透明 logo 不漏出底下 fallback 字母,且不随主题翻转。 */}
      <AvatarImage
        src={src || ""}
        alt={alt ?? ""}
        className={cn("rounded-full bg-logo-bg object-contain", plateClassName)}
      />
      <AvatarFallback
        className={cn("bg-transparent font-medium text-muted-foreground", s.fallback, fallbackClassName)}
      >
        {fallback?.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
