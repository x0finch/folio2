"use client";

import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@folio/ui/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./motion/popover";

// hover 弹层统一接线(手搓 token-only 组合件,包 beUI Popover;LiqRing / NoteIndicator 共用,
// code review 消跨包双写):
// · 打开抬 z-50 —— 面板 root 内绝对定位、不 portal,不抬会被后续不透明兄弟盖住;
// · 关闭态隐藏 goo 垫底层(root 直接 aria-hidden 子级 = goo filter svg + 常驻 bg-popover 触发器
//   药丸),触发器底下不垫色;隐藏延迟到收合弹簧走完,避免面板文字无底色悬浮收合(review #4);
// · side 按触发器在视口的上下可用空间动态选(review #5:固定向上在抽屉滚动容器顶部行会被裁,
//   固定向下在 SharedLayoutBg 行列表/视口底部同理)。
// 键盘可达性由调用方保证:children 传可聚焦元素(如 <button>),hover 模式对 focus/blur 同样生效。

// ≥ beUI popover GOO_SPRING 收合时长;早于它隐藏垫底层会露出无底色的收合中面板。
const POPOVER_COLLAPSE_MS = 400;

export function HoverPopover({
  children,
  content,
  className,
}: {
  /** 触发器,单个元素;需要键盘可达时传可聚焦元素(<button> 等)。 */
  children: ReactElement;
  content: ReactNode;
  /** 面板(PopoverContent)附加类。 */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [backdropHidden, setBackdropHidden] = useState(true);
  const [side, setSide] = useState<"top" | "bottom">("bottom");
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onOpenChange = (next: boolean) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (next) {
      // 打开瞬间按可用空间定方向(onOpenChange 同步于动画启动前,方向在首帧前就位)。
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setSide(rect.top > window.innerHeight - rect.bottom ? "top" : "bottom");
      setBackdropHidden(false);
    } else {
      hideTimer.current = setTimeout(() => setBackdropHidden(true), POPOVER_COLLAPSE_MS);
    }
    setOpen(next);
  };
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  return (
    <Popover
      trigger="hover"
      side={side}
      onOpenChange={onOpenChange}
      className={cn("shrink-0", open && "z-50", backdropHidden && "[&>[aria-hidden]]:hidden")}
    >
      <PopoverTrigger>
        <span ref={anchorRef} className="flex items-center">
          {children}
        </span>
      </PopoverTrigger>
      <PopoverContent className={className}>{content}</PopoverContent>
    </Popover>
  );
}
