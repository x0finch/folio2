"use client";

import { useRef, useState } from "react";

// beUI Popover(trigger="hover")的调用侧行为,做成 hook 而非包装组件——调用方继续直接
// 组合 Popover/PopoverTrigger/PopoverContent,这里只共享「行为」(LiqRing / NoteIndicator 共用):
// side 按触发器在视口的上下可用空间动态选(固定向上在滚动容器顶部行被裁,固定向下在视口底部同理)。
//
// **原先还管两件事,这次同步 beUI 后删掉了**:
// · 打开抬 z-50 —— 面板那时在 root 内绝对定位,会被后面的不透明兄弟盖住;现在它 portal 到 body、
//   自带 z-[9999],不用调用侧操心;
// · 关闭态隐藏 goo 垫底层(`[&>[aria-hidden]]:hidden`)—— 那是「宽触发器底下透出 bg-popover 黑块」
//   的补丁;上游改成用 SVG mask 把触发器那块从垫底层里挖掉,且垫底层也进了 portal,那个选择器
//   现在什么都匹配不到。
//
// 用法:side/onOpenChange 接到 <Popover>,measureRef 挂到触发元素(PopoverTrigger 会 mergeRefs,不冲突)。

export function useHoverPopover() {
  // 默认值基本不起作用:onOpenChange 与「打开」同一批更新,方向在首帧前就定了。留 top 只为不白改行为。
  const [side, setSide] = useState<"top" | "bottom">("top");
  const anchor = useRef<HTMLElement | null>(null);

  const measureRef = (node: HTMLElement | null) => {
    anchor.current = node;
  };
  const onOpenChange = (next: boolean) => {
    if (!next) return;
    // 打开瞬间按可用空间定方向(onOpenChange 同步于动画启动前,方向在首帧前就位)。
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setSide(rect.top > window.innerHeight - rect.bottom ? "top" : "bottom");
  };

  return { side, onOpenChange, measureRef };
}
