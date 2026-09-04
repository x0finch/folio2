import { animate } from "motion/react";
import { Activity, type ReactNode, type Ref, Suspense, useImperativeHandle, useRef } from "react";

// 一个**保活面板**:把内容裹在 React 原生 `<Activity>` 里隐藏保活(不卸载、留状态),并**自己**负责入场动画
// (淡入 + 微上抬,弹簧)。对"页 / 路由 / 连点"一无所知 —— 那些是 PageSwitcher 协调器的事。
// 入场经 ref 的 `enter()` 命令式播放:协调器在新页数据就绪后调它,resolve 即动画完成。

const LIFT_PX = 14; // 入场上抬:新页从下方 14px 浮上来
// 入场弹簧(Motion UI hero reveal 那种手感):不是定时缓动到点急停,而是弹簧自然减速、带一点回弹。
const ENTER_SPRING = { type: "spring", visualDuration: 0.5, bounce: 0.22 } as const;

/** 等浏览器真画出一帧(两次 rAF)—— `<Activity>` 揭示是低优先级提交,iOS 上可能偏晚,不等就会在还没上屏的元素上跑动画。 */
const nextPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** 这个面板此刻的角色。incoming = 挂着但还没入场(opacity 0、垫在最上层等 enter);shown = 已在场;hidden = 保活隐藏。 */
export type PanelState = "hidden" | "incoming" | "shown";

export interface KeepAlivePanelHandle {
  /** 播入场:从 opacity 0 + 上抬 14px 弹到位。`reduce` 时瞬到、不动。resolve 即完成。 */
  enter(reduce: boolean): Promise<void>;
}

export function KeepAlivePanel({
  state,
  children,
  ref,
}: {
  state: PanelState;
  children: ReactNode;
  ref?: Ref<KeepAlivePanelHandle>;
}) {
  const el = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      async enter(reduce) {
        const node = el.current;
        if (!node) return;
        node.style.opacity = "0";
        node.style.transform = `translateY(${LIFT_PX}px)`;
        await nextPaint();
        if (reduce) {
          node.style.opacity = "1";
          node.style.transform = "translateY(0px)";
          return;
        }
        await animate(node, { opacity: 1, y: 0 }, ENTER_SPRING).finished;
        node.style.opacity = "1"; // 钉死终态,避免 React 提交前的一帧缝
        node.style.transform = "translateY(0px)";
      },
    }),
    [],
  );

  return (
    <Activity mode={state === "hidden" ? "hidden" : "visible"}>
      <div
        ref={el}
        // incoming:挂着但还没 enter → opacity 0、垫在最上层(zIndex 1)盖住底下不透明的旧页,等 enter 淡上来。
        // shown:opacity 1、zIndex 0 在下面。只动 opacity/transform;外层 grid 的 isolation 把 zIndex 关在层内。
        style={{
          gridArea: "1 / 1",
          opacity: state === "incoming" ? 0 : 1,
          zIndex: state === "incoming" ? 1 : 0,
          minWidth: 0,
        }}
      >
        <Suspense fallback={null}>{children}</Suspense>
      </div>
    </Activity>
  );
}
