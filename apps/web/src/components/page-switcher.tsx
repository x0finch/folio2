import { EASE_OUT } from "@folio/ui/lib/ease";
import { animate, useReducedMotion } from "motion/react";
import { Activity, type ComponentType, Suspense, useEffect, useRef, useState } from "react";

// 可复用的 page 切换器(FOL-79)。跟路由无关:吃一份"页注册表" + 外部传入的当前 key。
// 三块现成 + 一点胶水:保活用 React 原生 `<Activity>`,补间用 motion,胶水是"等新页就绪再入场淡入"。
//
// 为什么这点胶水非自己写不可(见 FOL-69 grill):切到一个**异步加载**的页时,直接淡会淡到还没加载好的
// 页上闪一下(害死过 View Transitions / AnimatePresence / DOM 盖板)。这里切走时不立刻淡 —— 先把目标页挂上
// (Activity 可见、opacity 0),`await ready(key)`(chunk + 数据就绪)期间旧页仍不透明顶着,好了新页再淡入覆上来。
// 只动 opacity、grid 同格叠放、不带 transform;`isolation:isolate` 把内部 z-index 关在自己层里 —— 绝不逃出去
// 盖到外面 fixed 的 Dock / absolute 的 HeaderSync(逃出去 iOS 上会闪)。

export interface SwitcherPage {
  key: string;
  /** 通常是 `React.lazy(() => import(...))`。 */
  Component: ComponentType;
  /** chunk + 数据就绪时 resolve;**必须可重复调用且命中即秒回**(懒加载 import 与 react-query 天然缓存)。 */
  ready?: () => Promise<unknown>;
}

const FADE_S = 0.4;
const LIFT_PX = 8; // 入场微上抬:新页从下方 8px 升到位

/** 等浏览器真画出一帧(两次 rAF:第一次排到当前帧尾,第二次跨到下一帧后)。 */
const nextPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export function PageSwitcher({ pages, activeKey }: { pages: SwitcherPage[]; activeKey: string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(activeKey);
  const [incoming, setIncoming] = useState<string | null>(null);
  // 去过的 page(含当前):保活集合,只增不减。
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([activeKey]));
  const panels = useRef(new Map<string, HTMLDivElement>());
  const shownRef = useRef(activeKey); // 同步镜像 shown,供异步循环内读取最新已显示页
  const latest = useRef(activeKey); // 最新想去的目标(每次 activeKey 变都更新)
  const draining = useRef(false); // 是否已有一个循环在往 latest 收敛
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只由 activeKey 驱动;其余走 ref,避免旧闭包。
  useEffect(() => {
    latest.current = activeKey;
    if (draining.current) return; // 已有循环在跑,它每轮都读 latest,会自己追上
    draining.current = true;
    (async () => {
      // 一直把画面收敛到 latest —— 切换途中连点会更新 latest,循环下一轮直接奔最新,不丢、不逐个补。
      while (alive.current && latest.current !== shownRef.current) {
        const target = latest.current;
        setMounted((m) => (m.has(target) ? m : new Set(m).add(target)));
        setIncoming(target); // 目标页挂上:Activity 可见,先 opacity 0(见下面 style)

        await pages.find((p) => p.key === target)?.ready?.(); // 期间旧页仍不透明顶着,加载多久都不空
        if (!alive.current || latest.current !== target) continue; // 途中又改了目标 → 重奔最新

        // 新页在旧页**之上**淡入(zIndex 垫高、被 isolation 关在层内),旧页保持不透明留在下面、不交叉淡出:
        // 两层半透明叠白底中点会发灰、像瞬切;新页 0→1 覆上来才是清清楚楚的"入场"。淡完把旧页隐藏保活。
        const inEl = panels.current.get(target);
        if (inEl) {
          // **先让新面板真画出一帧再动**:`<Activity>` 的揭示是低优先级提交,iOS 上可能偏晚 —— 不等这一下
          // 就在还没上屏的元素上跑动画,跑完内容才落定弹出来 = 看着没动画。等两帧确保它在屏上(起始态)。
          // 入场 = 淡入 + 微上抬:新页从 opacity 0 + translateY(8px) 升到 opacity 1 + translateY(0)。
          // transform 作用在整块面板上,同步条(HeaderSync)在页内、跟着一起升,静止态位置不变、不跳。
          inEl.style.opacity = "0";
          inEl.style.transform = `translateY(${LIFT_PX}px)`;
          await nextPaint();
          if (!alive.current || latest.current !== target) continue;
          const opts = { duration: reduce ? 0 : FADE_S, ease: EASE_OUT } as const;
          await animate(inEl, { opacity: [0, 1], y: [LIFT_PX, 0] }, opts).finished;
          inEl.style.opacity = "1"; // 钉死终态,避免 React 提交前的一帧缝
          inEl.style.transform = "translateY(0px)";
        }
        if (!alive.current) break;

        shownRef.current = target;
        setShown(target);
        setIncoming(null);
      }
      draining.current = false;
    })();
  }, [activeKey]);

  return (
    <div style={{ display: "grid", isolation: "isolate", position: "relative" }}>
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
