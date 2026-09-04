import { useReducedMotion } from "motion/react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { KeepAlivePanel, type KeepAlivePanelHandle, type PanelState } from "./keep-alive-panel";

// 可复用的 page 切换器(FOL-69)。跟路由无关:吃一份"页注册表" + 外部传入的当前 key。
// 只做**协调**:哪个页在前、保活集合、连点收敛到最新、以及时机 —— 切走时不立刻淡,先把目标页挂上(保活面板
// 以 incoming 态在最上层、opacity 0),`await ready(key)`(chunk + 数据就绪)期间旧页仍不透明顶着,好了再叫
// 那个面板 `enter()` 淡入上抬覆上来。**怎么保活、怎么入场**在 `KeepAlivePanel` 里,这里不碰。
//
// 为什么"等就绪再入场"非自己写不可(见 FOL-69 grill):切到异步加载的页时,直接淡会淡到还没加载好的页上闪一下
// (害死过 View Transitions / AnimatePresence / DOM 盖板)。旧页顶着等,是这套的关键。

export interface SwitcherPage {
  key: string;
  /** 通常是 `React.lazy(() => import(...))`。 */
  Component: ComponentType;
  /** chunk + 数据就绪时 resolve;**必须可重复调用且命中即秒回**(懒加载 import 与 react-query 天然缓存)。 */
  ready?: () => Promise<unknown>;
}

export function PageSwitcher({ pages, activeKey }: { pages: SwitcherPage[]; activeKey: string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(activeKey);
  const [incoming, setIncoming] = useState<string | null>(null);
  // 去过的 page(含当前):保活集合,只增不减。
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([activeKey]));
  const handles = useRef(new Map<string, KeepAlivePanelHandle | null>());
  const shownRef = useRef(activeKey); // 同步镜像 shown,供异步循环内读取
  const latest = useRef(activeKey); // 最新想去的目标
  const draining = useRef(false); // 是否已有循环在往 latest 收敛
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
    if (draining.current) return; // 已有循环在跑,它每轮读 latest 会自己追上
    draining.current = true;
    (async () => {
      // 一直把画面收敛到 latest —— 切换途中连点会更新 latest,循环下一轮直接奔最新,不丢、不逐个补。
      while (alive.current && latest.current !== shownRef.current) {
        const target = latest.current;
        setMounted((m) => (m.has(target) ? m : new Set(m).add(target)));
        setIncoming(target); // 目标面板转 incoming 态(挂上、opacity 0、垫最上层),旧页仍不透明顶着
        await pages.find((p) => p.key === target)?.ready?.(); // 加载多久都不空
        if (!alive.current || latest.current !== target) continue; // 途中又改了目标 → 重奔最新
        await handles.current.get(target)?.enter(reduce ?? false); // 叫这个面板播入场(淡入 + 上抬),等它演完
        if (!alive.current) break;
        shownRef.current = target;
        setShown(target); // 目标 → shown;旧页转 hidden 隐藏保活
        setIncoming(null);
      }
      draining.current = false;
    })();
  }, [activeKey]);

  const stateOf = (key: string): PanelState =>
    key === incoming ? "incoming" : key === shown ? "shown" : "hidden";

  return (
    // isolation:isolate 把面板内部的 zIndex 关在自己层里 —— 绝不逃出去盖到外面 fixed 的 Dock(逃出去 iOS 上会闪)。
    <div style={{ display: "grid", isolation: "isolate", position: "relative" }}>
      {pages
        .filter((p) => mounted.has(p.key))
        .map((p) => (
          <KeepAlivePanel
            key={p.key}
            state={stateOf(p.key)}
            ref={(h) => {
              handles.current.set(p.key, h);
            }}
          >
            <p.Component />
          </KeepAlivePanel>
        ))}
    </div>
  );
}
