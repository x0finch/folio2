import { Activity, type ComponentType, type ReactNode, Suspense, useState } from "react";

// 可复用的 page 切换器(FOL-79)。跟路由无关:吃一份"页注册表" + 外部传入的当前 key。
//
// 三件事,各用原生原语,没有自定义动画 / 协调器:
// - **保活**:每个去过的页裹在 React 原生 `<Activity>` 里,当前页 `visible`、其余 `hidden`。隐藏 = 留状态 + 留 DOM
//   (滚动、表单都在)、但清掉 effect(后台不空转);切回来即时、原样。
// - **首次加载 = lazy**:没进过的页**根本不进树** → 它的 `React.lazy` chunk 永不请求。第一次切过去才挂载(import
//   触发),这一刻 `Suspense` 用该页自己的 `Skeleton` 顶着;chunk + 数据到了原地换成真页。
// - **切换即时**:切换就是改 `activeKey`,Activity 秒切,没有过场动画、没有连点收敛问题(即时切本身就收敛)。

export interface SwitcherPage {
  key: string;
  /** 通常是 `React.lazy(() => import(...))`;首次挂载时由 `Skeleton`(或 `fallback`)顶着。 */
  Component: ComponentType;
  /** 该页首次加载时的骨架;没给就用 PageSwitcher 的通用 `fallback`。 */
  Skeleton?: ComponentType;
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
            <Activity key={p.key} mode={p.key === activeKey ? "visible" : "hidden"}>
              <Suspense fallback={Skeleton ? <Skeleton /> : (fallback ?? null)}>
                <p.Component />
              </Suspense>
            </Activity>
          );
        })}
    </div>
  );
}
