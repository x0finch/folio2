import { cn } from "@folio/ui";
import { EASE_DRAWER } from "@folio/ui/lib/ease";
import {
  AnimatePresence,
  animate,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { chooseSnap, SHEET_MAX_HEIGHT, snapOffsets } from "../lib/bottom-sheet-snap";
import { useScrollLock } from "../lib/hooks/use-scroll-lock";
import { useSheetProgress } from "../lib/sheet-progress";
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
// **拖动是直接的,松手用一条固定曲线**(`EASE_DRAWER` = vaul 那条 `cubic-bezier(0.32, 0.72, 0, 1)`)。
// 这与 ADR 0041 里「惯性交给 motion 的 `dragTransition.modifyTarget`」**相反,是被真机推翻的**:
// 惯性投影让换档距离恒等于半个间距(实测 338px 的间距要拖过 169px 才认),而 dismiss 会拖出一条
// 软塌塌的长尾。判据搬进 `chooseSnap`(位移 / 速度双判据,纯函数、可测),动画则是一条可预期的曲线。
// 拖动本身仍然完全跟手,动画中途反向拖也照旧 —— motion 一开始拖就会把在跑的动画停掉。

// 开合那一下的时长与曲线:与 vendored Drawer 同款(EASE_DRAWER),两处抽屉手感一致。
const OPEN_TRANSITION = { duration: 0.42, ease: EASE_DRAWER } as const;
// 换档比开合短一点:开合是「一个面板进来/出去」,换档只是同一个面板挪个位置。
const SNAP_TRANSITION = { duration: 0.32, ease: EASE_DRAWER } as const;
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
  // memo 不是为了省算力,是为了身份稳定:下面那个订阅以 offsets 为依赖,每次渲染换个新数组
  // 就会每次重订一遍。
  const offsets = useMemo(() => snapOffsets(maxHeight), [maxHeight]);
  const dismissOffset = offsets[offsets.length - 1] ?? 0;
  // 当前停在哪一档(位移)。默认半档 —— 与被替掉的组件一致。
  const [snap, setSnap] = useState(0);
  // 这一下拖了多远/多快(松手时用)。放 ref:每帧都在变,进 state 只会白渲染。
  const drag = useRef({ offset: 0, velocity: 0 });
  // 这一次的位移变化是「松手落档」还是「开合」——两者时长不同(见上面两个常量)。
  const settling = useRef(false);

  // 打开时锁住背后那个滚动容器(片1 的 hook,锁的是容器不是 body)。
  useScrollLock(open);

  // 上滑进度喂给外壳去缩放(片9)。**同一个 y 驱动三件事** —— 抽屉位置、遮罩透明度、背景缩放,
  // 所以它们天然同步:松手到位时一起停,不需要各自补一段动画。
  const progress = useSheetProgress();
  useEffect(() => {
    if (!open || maxHeight === 0) {
      progress.set(0);
      return;
    }
    const push = (value: number) => {
      // 开场那一下的起点是 `y: "100%"`(百分号,motion 还没换算成 px)—— `Number("100%")` 是 NaN。
      // 不判这一下就会把 NaN 灌给外壳,`scale(NaN)` 被浏览器整条丢掉:**表现是「缩放没生效」而不报错**。
      const px = Number(value);
      if (!Number.isFinite(px)) return;
      progress.set(1 - Math.min(1, Math.max(0, px / maxHeight)));
    };
    push(y.get());
    const stop = y.on("change", push);
    return () => {
      stop();
      // 关掉/卸载时必须归零:外壳那一层看到 0 才会把 transform **彻底删掉**(而不是留个恒等缩放)。
      progress.set(0);
    };
  }, [open, maxHeight, progress, y]);

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
    settling.current = false;
    setSnap(offsets.at(-2) ?? 0);
  }, [open, maxHeight, offsets]);

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
              // `bg-black/40` 而不是 `bg-background/40`:后者在浅色主题下是**白盖白**,压根不暗 ——
              // 而背景缩放会在屏幕四周露出一圈,那一圈就成了纯白的「空白」(真机上第一眼看到的就是它)。
              // 换成与桌面侧滑 `Drawer` 同一个遮罩色,露出的那一圈立刻读作「垫在后面的深色底」。
              className="pointer-events-auto absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              ref={sheetRef}
              style={{ height: SHEET_MAX_HEIGHT, y }}
              // 位移驱动一切:跟手、落档、退场都是同一个 y。
              initial={reduce ? { opacity: 0 } : { y: "100%" }}
              // 顶格高度还没量出来时先按住 100%(整块在屏外):那一瞬 snap 还是 0(顶档),
              // 直接 animate 过去会先冲到顶再回落半档 —— 每次打开都看得见那一下多余的过冲。
              animate={
                maxHeight === 0 ? { y: "100%" } : reduce ? { opacity: 1, y: snap } : { y: snap }
              }
              exit={reduce ? { opacity: 0 } : { y: "100%" }}
              transition={
                reduce ? REDUCED_TRANSITION : settling.current ? SNAP_TRANSITION : OPEN_TRANSITION
              }
              drag="y"
              dragControls={dragControls}
              dragListener={false}
              // 上不过顶格、下不过完全移出;两头都不给弹性 —— 档位本身已经包含了这两个极限。
              dragConstraints={{ top: offsets[0] ?? 0, bottom: dismissOffset }}
              dragElastic={0}
              // 惯性关掉:落点与速度由 `chooseSnap` 定,动画走固定曲线(理由见顶部那段)。
              dragMomentum={false}
              onDrag={(_, info) => {
                drag.current = { offset: info.offset.y, velocity: info.velocity.y };
              }}
              onDragEnd={() => {
                const target = chooseSnap({ from: snap, offsets, ...drag.current });
                settling.current = true;
                // 落到 dismiss 就直接关:退场动画本身就是「滑出屏外」(exit 的 y: "100%" 等于
                // dismiss 那个位移),于是手势与退场是同一条动画,不用再单独跑一段。
                if (target === dismissOffset) {
                  onOpenChange(false);
                  return;
                }
                // **命令式地动过去,不指望 `animate` prop**:拖一点点又松手时目标就是当前这一档,
                // `setSnap` 写进去的值没变 → prop 不会重跑 → 抽屉就停在手指松开的地方不回弹
                // (真机上就是这个:往下拖 60px 松手,它卡在 60px 处)。
                setSnap(target);
                animate(y, target, reduce ? { duration: 0 } : SNAP_TRANSITION);
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
