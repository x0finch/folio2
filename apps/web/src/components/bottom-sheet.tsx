import { cn } from "@folio/ui";
import { EASE_DRAWER } from "@folio/ui/lib/ease";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { nearestSnap, SHEET_MAX_HEIGHT, snapOffsets } from "../lib/bottom-sheet-snap";
import { useScrollLock } from "../lib/hooks/use-scroll-lock";
import { Portal } from "./portal";

// 移动端底部抽屉(片8 / ADR 0041)。自己写,不引 vaul —— vaul 依赖 @radix-ui/react-dialog,
// 而 ADR 0004 正是把 Radix 请出去的那条决定。机制照 vaul:**高度恒定,档位用位移表达**。
//
// 与被它替掉的 vendored 件比,变了三件事:
//   · 半档 ↔ 全展开**跟着手指连续移动**(旧的是改高度 + `dragElastic.top: 0.02`,向上基本拖不动,
//     只能甩一下让它 teleport);
//   · 顶格高度扣掉了 `env(safe-area-inset-top)` → 灵动岛压不到是**结构保证**,不是 92% 这种凑的数;
//   · Esc 能关(旧的没有)。
//
// **动画交给 motion,策略留给自己**:惯性投影用 `dragTransition.modifyTarget`(motion 按自己的
// 衰减模型算「照这速度会滑到哪」,我们只回答「离它最近的合法档位是哪个」),`dragMomentum` 保持开着 ——
// 关掉它就等于把惯性收回自己手里,那正是旧组件的做法。动画中途反向拖不僵住因此是白拿的。

// 开合那一下的时长与曲线:与 vendored Drawer 同款(EASE_DRAWER),两处抽屉手感一致。
const OPEN_TRANSITION = { duration: 0.42, ease: EASE_DRAWER } as const;
const REDUCED_TRANSITION = { duration: 0.18, ease: EASE_DRAWER } as const;
// 内容区在非顶档时不滚(整块可拖);到顶档才交回原生滚动。
const DRAG_FROM_CONTENT_PX = 4;

export function BottomSheet({
  open,
  onOpenChange,
  ariaLabel,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel?: string;
  children?: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const dragControls = useDragControls();
  const y = useMotionValue(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 顶格高度得按**像素**知道才能算档位;CSS 那个 calc 只有浏览器算得出 → 量出来。
  const [maxHeight, setMaxHeight] = useState(0);
  const offsets = snapOffsets(maxHeight);
  const dismissOffset = offsets[offsets.length - 1] ?? 0;
  // 当前停在哪一档(位移)。默认半档 —— 与被替掉的组件一致。
  const [snap, setSnap] = useState(0);

  // 打开时锁住背后那个滚动容器(片1 的 hook,锁的是容器不是 body)。
  useScrollLock(open);

  // 顶格高度随视口变(键盘弹起 / 旋转)→ 重量一次,各档目标跟着重算。
  useEffect(() => {
    const el = sheetRef.current;
    if (!open || !el) return;
    const measure = () => setMaxHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // 每次打开都从半档开始(而不是上次关掉时那一档)。
  useEffect(() => {
    if (!open || maxHeight === 0) return;
    setSnap(snapOffsets(maxHeight).at(-2) ?? 0);
  }, [open, maxHeight]);

  // Esc 关闭 —— 旧的 vendored 件没有这个。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const atTop = snap === offsets[0];

  // 内容区到顶之后继续下拉 → 把手势交给抽屉,一个连续手势(不是「先松手再拖」)。
  // 方向要等 pointermove 才知道,所以判定放在 move 里:还在顶上(scrollTop <= 0)且确实在往下拉。
  const startY = useRef(0);
  const onContentPointerDown = (e: ReactPointerEvent) => {
    startY.current = e.clientY;
    // 非顶档时内容不滚,整块直接可拖。
    if (!atTop) dragControls.start(e);
  };
  const onContentPointerMove = (e: ReactPointerEvent) => {
    if (!atTop) return;
    const el = contentRef.current;
    if (!el || el.scrollTop > 0) return;
    if (e.clientY - startY.current > DRAG_FROM_CONTENT_PX) dragControls.start(e);
  };

  return (
    <Portal>
      <AnimatePresence>
        {open ? (
          <div className="pointer-events-none fixed inset-0 z-50">
            <motion.button
              type="button"
              aria-label="Close bottom sheet"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduce ? REDUCED_TRANSITION : OPEN_TRANSITION}
              onClick={() => onOpenChange(false)}
              className="pointer-events-auto absolute inset-0 bg-background/40 backdrop-blur-sm"
            />
            <motion.div
              ref={sheetRef}
              style={{ height: SHEET_MAX_HEIGHT, y }}
              // 位移驱动一切:跟手、落档、退场都是同一个 y。
              initial={reduce ? { opacity: 0 } : { y: "100%" }}
              animate={reduce ? { opacity: 1, y: snap } : { y: snap }}
              exit={reduce ? { opacity: 0 } : { y: "100%" }}
              transition={reduce ? REDUCED_TRANSITION : OPEN_TRANSITION}
              drag="y"
              dragControls={dragControls}
              dragListener={false}
              // 上不过顶格、下不过完全移出;两头都不给弹性 —— 档位本身已经包含了这两个极限。
              dragConstraints={{ top: offsets[0] ?? 0, bottom: dismissOffset }}
              dragElastic={0}
              // 惯性交给 motion,我们只把它算出的落点改成最近的合法档位。
              dragTransition={{
                modifyTarget: (target) => nearestSnap(target, offsets),
              }}
              onDragEnd={() => {
                // 落点由 modifyTarget 定;这里只把「停在哪一档」同步回 state,
                // 好让下一次 animate 与内容区能不能滚都对得上。
                const landed = nearestSnap(y.get(), offsets);
                setSnap(landed);
                if (landed === dismissOffset) onOpenChange(false);
              }}
              role="dialog"
              aria-modal="true"
              aria-label={ariaLabel}
              className={cn(
                "pointer-events-auto absolute inset-x-0 bottom-0 mx-auto flex max-w-2xl flex-col overflow-hidden rounded-t-3xl",
                "border border-border bg-background shadow-xl will-change-transform",
                className,
              )}
            >
              {/* 手柄:始终可拖(touch-none 把这一带的原生手势让给拖拽)。 */}
              <div
                onPointerDown={(e) => dragControls.start(e)}
                className="flex cursor-grab touch-none flex-col items-center px-4 pt-3 pb-2 active:cursor-grabbing"
              >
                <div className="h-1.5 w-10 rounded-full bg-muted-foreground/40" />
              </div>
              {/* 内容:顶档才交回原生滚动;非顶档整块可拖。底部内边距叠加安全区,不被 home 指示条压。 */}
              <div
                ref={contentRef}
                onPointerDown={onContentPointerDown}
                onPointerMove={onContentPointerMove}
                className={cn(
                  "flex-1 overscroll-contain px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]",
                  atTop ? "overflow-y-auto" : "overflow-hidden",
                )}
              >
                {children}
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </Portal>
  );
}
