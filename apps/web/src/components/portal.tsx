import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// 把内容挂到 <body>,逃出祖先的 transform/overflow 包含块。BottomSheet 的 motion.div 带 will-change-transform +
// Framer drag 的 translateY(常驻 transform)→ 成为 position:fixed 后代的包含块,叠加自身 overflow-hidden 会裁掉
// 内部 fixed 弹层(MorphingModal)。vendored BottomSheet 对自身也是靠 portal 到 body 规避此陷阱。
// SSR 安全:挂载前不渲染(弹层皆交互驱动,不影响首屏)。
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
