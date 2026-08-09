import { Button, cn } from "@folio/ui";
import type { ComponentProps, ReactNode } from "react";

// 方形纯图标动作按钮(#146):关闭 ✕、返回 ←、更多 ⋯、刷新 ⟳ 这一类。
//
// **它包 beUI 的 `Button`,不从零手搓** —— 按下回弹与 hover 微放大那套动效跟着一起来,不用复刻。
//
// 两处刻意偏离 beUI 默认:
// ① **圆底而不是圆角方块。** beUI 的 `size="icon"` 是 `rounded-lg`,而且**上游就是这样**
//    (跑过 `shadcn add @beui/button-base` 核对过,不是我们改坏的)。方形图标按钮的 hover 底
//    做成全圆才和站里其它圆形控件协调,所以在这一层覆盖 —— 不去改 registry 件:那个文件已经是
//    fork(多了 `destructive` 与 `buttonVariants`),再加一条,下次同步要多对一遍。
// ② **hover 底用 `bg-muted` 而不是 ghost 自带的 `bg-primary/5`。** 后者在暗色主题下肉眼几乎
//    看不出来(设置页那颗加 passkey 的按钮早就为此就地覆盖过,注释还在)。
//
// 尺寸只开三档,对应站里实际用到的 28 / 32 / 36px;图标自身的大小仍由调用点给
// (`<X className="size-4" />`),不在这里替它决定。
const SIZE_CLASS = {
  sm: "size-7",
  md: "size-8",
  lg: "size-9",
} as const;

type ButtonProps = ComponentProps<typeof Button>;

export interface IconButtonProps extends Omit<ButtonProps, "size" | "children"> {
  size?: keyof typeof SIZE_CLASS;
  /**
   * **必填,不是可选。** 纯图标按钮没有可读文本,少了它读屏念出来就只有「按钮」两个字。
   * 写成必填是这个组件相对一个 class 工具唯一拿得出手的东西 —— 类型能逼着你写,class 不能。
   */
  "aria-label": string;
  children: ReactNode;
}

export function IconButton({
  size = "md",
  variant = "ghost",
  className,
  ...rest
}: IconButtonProps) {
  return (
    <Button
      type="button"
      size="icon"
      variant={variant}
      className={cn("rounded-full hover:bg-muted", SIZE_CLASS[size], className)}
      {...rest}
    />
  );
}
