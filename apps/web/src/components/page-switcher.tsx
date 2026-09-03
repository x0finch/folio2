import { EASE_OUT } from "@folio/ui/lib/ease";
import { animate, useReducedMotion } from "motion/react";
import { Activity, type ComponentType, Suspense, useEffect, useRef, useState } from "react";

// 可复用的 page 切换器(FOL-79)。跟路由无关:吃一份"页注册表" + 外部传入的当前 key。
// 三块现成 + 一点胶水:保活用 React 原生 `<Activity>`,补间用 motion,胶水是"等新页就绪再交叉淡入"。
//
// 为什么这点胶水非自己写不可(见 FOL-69 grill):切到一个**异步加载**的页时,直接淡会淡到还没加载好的
// 页上闪一下(害死过 View Transitions / AnimatePresence / DOM 盖板)。这里切走时不立刻淡 —— 先把目标页挂上
// (Activity 可见、opacity 0),`await ready(key)`(chunk + 数据就绪)期间旧页仍 opacity 1 顶着,好了再淡。
// 只动 opacity、grid 同格叠放、不带 transform → 页内 absolute 定位的东西(如 HeaderSync)不跳。

export interface SwitcherPage {
  key: string;
  /** 通常是 `React.lazy(() => import(...))`。 */
  Component: ComponentType;
  /** chunk + 数据就绪时 resolve;**必须可重复调用且命中即秒回**(懒加载 import 与 react-query 天然缓存)。 */
  ready?: () => Promise<unknown>;
}

const FADE_S = 0.18;

export function PageSwitcher({ pages, activeKey }: { pages: SwitcherPage[]; activeKey: string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(activeKey);
  const [incoming, setIncoming] = useState<string | null>(null);
  // 去过的 page(含当前):保活集合,只增不减。
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([activeKey]));
  const panels = useRef(new Map<string, HTMLDivElement>());
  const busy = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在 activeKey 变时驱动切换,不追 shown/pages。
  useEffect(() => {
    if (activeKey === shown || busy.current) return;
    let cancelled = false;
    busy.current = true;
    const target = activeKey;

    (async () => {
      setMounted((m) => (m.has(target) ? m : new Set(m).add(target)));
      setIncoming(target); // 目标页挂上:Activity 可见,先 opacity 0(见下面 style)

      await pages.find((p) => p.key === target)?.ready?.(); // 期间旧页仍 opacity 1,加载多久都不空
      if (cancelled) return;

      // 新页在旧页**之上**淡入(靠 zIndex 垫高),旧页保持不透明留在下面、不做交叉淡出。
      // 为什么不对称交叉淡入:两层半透明叠在白底上,中点两边都发灰、看着像瞬切,入场感没了。
      // 新页 0→1 覆上来是清清楚楚的"入场";淡完再把旧页隐藏保活(它在下面被盖住,隐藏时无闪)。
      const inEl = panels.current.get(target);
      const opts = { duration: reduce ? 0 : FADE_S, ease: EASE_OUT } as const;
      if (inEl) await animate(inEl, { opacity: 1 }, opts).finished;
      if (cancelled) return;

      setShown(target); // 旧页 → Activity 隐藏保活
      setIncoming(null);
      busy.current = false;
    })();

    return () => {
      cancelled = true;
      busy.current = false;
    };
  }, [activeKey]);

  return (
    <div style={{ display: "grid" }}>
      {pages
        .filter((p) => mounted.has(p.key))
        .map((p) => {
          const visible = p.key === shown || p.key === incoming;
          const opacity = p.key === incoming ? 0 : 1; // incoming 从 0 起由 animate 拉到 1;其余 1
          return (
            <Activity key={p.key} mode={visible ? "visible" : "hidden"}>
              <div
                ref={(el) => {
                  if (el) panels.current.set(p.key, el);
                }}
                // incoming 垫在最上层淡入,盖住底下不透明的旧页;grid 子项无需定位即认 z-index。
                style={{
                  gridArea: "1 / 1",
                  opacity,
                  zIndex: p.key === incoming ? 1 : 0,
                  minWidth: 0,
                }}
              >
                <Suspense fallback={null}>
                  <p.Component />
                </Suspense>
              </div>
            </Activity>
          );
        })}
    </div>
  );
}
