import { SPRING_PANEL } from "@folio/ui/lib/ease";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Portal } from "./portal";

// 悬停/点按详情浮层:触发区 hover 或 tap → portal 到 <body> 的浮层。
// 为何自搓而非 beUI <Popover>:触发区在 SwipeableList 行内(行容器 overflow-hidden 遮操作轨),beUI Popover 的面板
// 是相对其 root 绝对定位、不 portal 的(goo morph 依赖触发器与面板共享同一局部坐标系,亦无法 portal 出来)→ 在此行内
// 会被裁成不可见。故 portal 到 body 逃出裁剪;动效仍走仓库同一 motion 层(motion/react + SPRING_PANEL token)。
// 交互与 beUI hover popover 一致:桌面 hover 进出、触屏 tap 打开(浏览器 tap 合成 mouseenter)+ 点外部关闭 —— 绝不按
// 指针能力(hover/pointer 媒体查询)裁掉处理器,否则触屏本/平板等会「点不出来」。贴触发区下方,下方空间不足则上翻。

const CLOSE_DELAY = 120;
const PANEL_W = 256; // 与 w-64 对齐,用于左侧夹取与上翻阈值
const GAP = 8;
const FLIP_THRESHOLD = 220; // 下方剩余空间少于此值则上翻
const OFFSET = 6; // 入场时朝触发器一侧的位移量(px)

export function HoverDetail({
  children,
  detail,
  className,
}: {
  children: ReactNode; // 触发区内容(行左侧簇)
  detail: ReactNode; // 浮层内容
  className?: string; // 触发区外层 class(承载行内 flex 布局)
}) {
  const reduce = useReducedMotion() ?? false;
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  const clearTimer = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const open = useCallback(() => {
    clearTimer();
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - PANEL_W - GAP));
    // 下方空间不足 → 以触发区顶为锚上翻。
    if (window.innerHeight - r.bottom < FLIP_THRESHOLD) {
      setPos({ left, bottom: window.innerHeight - r.top + GAP });
    } else {
      setPos({ left, top: r.bottom + GAP });
    }
  }, [clearTimer]);

  const scheduleClose = useCallback(() => {
    clearTimer();
    closeTimer.current = setTimeout(() => setPos(null), CLOSE_DELAY);
  }, [clearTimer]);

  // 打开时:点触发区/面板之外即关闭(触屏 tap 打开后靠此收起,桌面亦然)。
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      clearTimer();
      setPos(null);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [pos, clearTimer]);

  // 无可展开内容:只渲染触发内容,不挂交互。
  if (!detail) return <div className={className}>{children}</div>;

  const flipped = pos?.bottom != null; // 上翻(面板在触发区上方)
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover/tap 富化,详情另可经 swipe 编辑访问。
          触屏 tap 由浏览器合成 mouseenter 打开(与 beUI hover popover 同机制),点外部关闭见上方 effect。 */}
      <div ref={triggerRef} onMouseEnter={open} onMouseLeave={scheduleClose} className={className}>
        {children}
      </div>
      {/* Portal 常挂,AnimatePresence 才能在收起时播放退场。动效用 SPRING_PANEL(与 beUI 覆盖层入场同源)。 */}
      <Portal>
        <AnimatePresence>
          {pos && (
            <motion.div
              key="hover-detail-panel"
              ref={panelRef}
              onMouseEnter={clearTimer}
              onMouseLeave={scheduleClose}
              initial={{ opacity: 0, scale: 0.96, y: flipped ? OFFSET : -OFFSET }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: flipped ? OFFSET : -OFFSET }}
              transition={reduce ? { duration: 0 } : SPRING_PANEL}
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                bottom: pos.bottom,
                transformOrigin: flipped ? "left bottom" : "left top",
              }}
              className="z-[60] w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
            >
              {detail}
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
