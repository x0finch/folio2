import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { Activity, type ReactNode, Suspense, useEffect } from "react";

// 一个**保活面板**:把内容裹在 React 原生 `<Activity>` 里隐藏保活(不卸载、留状态),并**自己**声明式地播入场
// (淡入 + 微上抬,弹簧)。对"页 / 路由 / 连点"一无所知 —— 那些是 PageSwitcher 协调器的事。
//
// 动画走 motion 的通用 API:`<motion.div animate={controls}>` + `useAnimationControls`。协调器把这个面板置成
// `entering` 时,面板自己**先归位再弹到位**(保活的页再次进入也从头播),播完 `onEntered` 回调告诉协调器。
// 不手写补间、不用命令式 ref 句柄。

const LIFT_PX = 14; // 入场上抬:新页从下方 14px 浮上来
// 入场弹簧(Motion UI hero reveal 那种手感):不是定时缓动到点急停,而是弹簧自然减速、带一点回弹。
const ENTER_SPRING = { type: "spring", visualDuration: 0.5, bounce: 0.22 } as const;

/** 这个面板此刻的角色。entering = 正在入场(垫在最上层弹入);shown = 已在场;hidden = 保活隐藏。 */
export type PanelState = "hidden" | "entering" | "shown";

export function KeepAlivePanel({
  panelKey,
  state,
  fallback,
  onEntered,
  children,
}: {
  panelKey: string;
  state: PanelState;
  /** 架子(chunk)还没到时先显示的通用骨架;到了 Suspense 原地换成真内容。 */
  fallback?: ReactNode;
  /** 入场演完时回调(带 key),协调器据此把旧页收起来。 */
  onEntered?: (key: string) => void;
  children: ReactNode;
}) {
  const controls = useAnimationControls();
  const reduce = useReducedMotion();

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在 state 变为 entering 时播;其余走闭包/ref 无妨。
  useEffect(() => {
    if (state !== "entering") return;
    let cancelled = false;
    // 先归位(保活的页再次进入时,回到 opacity 0 + 下移 14px),再弹到位。
    controls.set({ opacity: 0, y: LIFT_PX });
    const done = reduce
      ? controls.set({ opacity: 1, y: 0 })
      : controls.start({ opacity: 1, y: 0 }, ENTER_SPRING);
    Promise.resolve(done).then(() => {
      if (!cancelled) onEntered?.(panelKey);
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  return (
    <Activity mode={state === "hidden" ? "hidden" : "visible"}>
      <motion.div
        animate={controls}
        initial={false}
        // entering 垫在最上层(zIndex 1)盖住底下不透明的旧页,淡入上抬覆上来;外层 grid 的 isolation 把 zIndex 关在层内。
        style={{ gridArea: "1 / 1", zIndex: state === "entering" ? 1 : 0, minWidth: 0 }}
      >
        <Suspense fallback={fallback ?? null}>{children}</Suspense>
      </motion.div>
    </Activity>
  );
}
