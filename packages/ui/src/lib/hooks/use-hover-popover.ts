"use client";

import { cn } from "@folio/ui/lib/utils";
import { useEffect, useRef, useState } from "react";

// beUI Popover(trigger="hover")的调用侧补丁行为,做成 hook 而非包装组件——调用方继续直接
// 组合 Popover/PopoverTrigger/PopoverContent,这里只共享「行为」(LiqRing / NoteIndicator 共用):
// · 打开抬 z-50:面板 root 内绝对定位、不 portal,不抬会被后续不透明兄弟盖住;
// · 关闭态隐藏 goo 垫底层(root 直接 aria-hidden 子级 = goo filter svg + 常驻 bg-popover 触发器
//   药丸),触发器底下不垫色;隐藏延迟到收合弹簧走完,避免面板文字无底色悬浮收合;
// · side 按触发器在视口的上下可用空间动态选(固定向上在滚动容器顶部行被裁,固定向下在
//   视口底部同理)。
// 用法:rootClassName/side/onOpenChange 接到 <Popover>,measureRef 挂到触发元素
// (PopoverTrigger 会 mergeRefs,不冲突)。

// ≥ beUI popover GOO_SPRING 收合时长;早于它隐藏垫底层会露出无底色的收合中面板。
const POPOVER_COLLAPSE_MS = 400;

export function useHoverPopover() {
  const [open, setOpen] = useState(false);
  const [backdropHidden, setBackdropHidden] = useState(true);
  const [side, setSide] = useState<"top" | "bottom">("bottom");
  const anchor = useRef<HTMLElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measureRef = (node: HTMLElement | null) => {
    anchor.current = node;
  };
  const onOpenChange = (next: boolean) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (next) {
      // 打开瞬间按可用空间定方向(onOpenChange 同步于动画启动前,方向在首帧前就位)。
      const rect = anchor.current?.getBoundingClientRect();
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

  return {
    side,
    onOpenChange,
    measureRef,
    // 仅行为类(抬 z / 关闭隐垫底);布局(shrink-0 或 flex-1)由调用方按锚点大小自定。
    rootClassName: cn(open && "z-50", backdropHidden && "[&>[aria-hidden]]:hidden"),
  };
}
