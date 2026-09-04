import { EASE_OUT } from "@folio/ui/lib/ease";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { Activity, type ComponentType, type ReactNode, Suspense, useEffect, useState } from "react";

// 可复用的 page 切换器(FOL-79)。跟路由无关:吃一份"页注册表" + 外部传入的当前 key。
//
// - **保活**:每个去过的页裹在 React 原生 `<Activity>` 里,当前页 `visible`、其余 `hidden`。隐藏 = 留状态 + 留 DOM
//   (滚动、表单都在)、但清掉 effect(后台不空转);切回来即时、原样。
// - **首次加载 = lazy**:没进过的页**根本不进树** → 它的 `React.lazy` chunk 永不请求。第一次切过去才挂载(import
//   触发),这一刻 `Suspense` 用该页自己的 `Skeleton` 顶着;chunk + 数据到了原地换成真页。
// - **进场渐变**:某页由隐藏转为当前页时,整页 opacity 0→1 淡入(见 `Panel`)。

export interface SwitcherPage {
  key: string;
  /** 通常是 `React.lazy(() => import(...))`;首次挂载时由 `Skeleton`(或 `fallback`)顶着。 */
  Component: ComponentType;
  /** 该页首次加载时的骨架;没给就用 PageSwitcher 的通用 `fallback`。 */
  Skeleton?: ComponentType;
}

// 进场只动 opacity,**不做位移 / 缩放**:页头 `<HeaderSync/>` 是 absolute 定位到 `<main>` 的,任何带
// transform 的包裹层会变成它的包含块,把同步条顶跳约 24px(老坑,见 tab-transition 的历史);transform
// 还会钉死持仓页那条 `sticky` 小额条。opacity 不建包含块、不碰布局,整页淡入是安全的那一档。
const FADE = { duration: 0.26, ease: EASE_OUT } as const;

// 一个保活面板:`<Activity>` 管可见性,`motion.div` 管进场淡入。由隐藏转为可见(成为当前页)时,从
// opacity 0 淡到 1;转为隐藏时归零,好让下次淡入从 0 起、不闪一帧全不透明。去过的页始终挂着,只是重播淡入。
function Panel({ active, children }: { active: boolean; children: ReactNode }) {
  const controls = useAnimationControls();
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) {
      controls.set({ opacity: 1 });
      return;
    }
    if (active) {
      controls.set({ opacity: 0 });
      controls.start({ opacity: 1 });
    } else {
      controls.set({ opacity: 0 });
    }
  }, [active, reduce, controls]);
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <motion.div initial={{ opacity: 0 }} animate={controls} transition={FADE}>
        {children}
      </motion.div>
    </Activity>
  );
}

export function PageSwitcher({
  pages,
  activeKey,
  fallback,
}: {
  pages: SwitcherPage[];
  activeKey: string;
  /** 页没自带 `Skeleton` 时的通用兜底骨架。 */
  fallback?: ReactNode;
}) {
  // 去过的页(含当前):只增不减。没进过的不进树,保证 lazy —— chunk 只在第一次切过去时才请求。
  const [visited, setVisited] = useState<Set<string>>(() => new Set([activeKey]));
  // 首次切到某页时在**渲染期**就并入 visited(React 认可的「渲染中调整 state」:立刻重渲染、不提交中间态)。
  // 这样新页在同一次提交里挂载 —— 不留 useEffect 那种「旧页已隐藏、新页还没挂」的空白帧。guard 保证不死循环。
  if (!visited.has(activeKey)) {
    setVisited((prev) => new Set(prev).add(activeKey));
  }

  return (
    <div>
      {pages
        .filter((p) => visited.has(p.key))
        .map((p) => {
          const Skeleton = p.Skeleton;
          return (
            <Panel key={p.key} active={p.key === activeKey}>
              <Suspense fallback={Skeleton ? <Skeleton /> : (fallback ?? null)}>
                <p.Component />
              </Suspense>
            </Panel>
          );
        })}
    </div>
  );
}
