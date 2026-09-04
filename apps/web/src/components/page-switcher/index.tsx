import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { KeepAlivePanel, type PanelState } from "./keep-alive-panel";

// 可复用的 page 切换器(FOL-69)。跟路由无关:吃一份"页注册表" + 外部传入的当前 key。
// 只做**协调**:哪个页在前、保活集合、连点收敛到最新。动画本身在 `KeepAlivePanel` 里声明式播。
//
// **切换永远即时,不等任何东西**:点一下就立刻让目标面板入场。目标页的架子(chunk)还没到时,Suspense 先显示
// 传进来的**通用骨架**(`fallback`);架子到了原地换成真页,数据再走页面自己那套骨架长出来。这样切换永远跟手、
// 不会因为某页慢而卡住;去过的页由 `<Activity>` 隐藏保活,切回来是原样、连骨架都不用再过。

export interface SwitcherPage {
  key: string;
  /** 通常是 `React.lazy(() => import(...))`;没到时由 `fallback` 骨架顶着。 */
  Component: ComponentType;
}

export function PageSwitcher({
  pages,
  activeKey,
  fallback,
}: {
  pages: SwitcherPage[];
  activeKey: string;
  /** 通用骨架:任一页架子未到时先显示它,到了 Suspense 原地替换。 */
  fallback?: ReactNode;
}) {
  const [shown, setShown] = useState(activeKey);
  const [incoming, setIncoming] = useState<string | null>(null);
  // 去过的 page(含当前):保活集合,只增不减。
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([activeKey]));
  const shownRef = useRef(activeKey); // 同步镜像 shown,供异步循环内读取
  const latest = useRef(activeKey); // 最新想去的目标
  const draining = useRef(false); // 是否已有循环在往 latest 收敛
  const alive = useRef(true);
  // 面板入场演完的回调桥:协调器 await 一个 promise,面板 `onEntered` 时 resolve 它。
  const enterResolvers = useRef(new Map<string, () => void>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    latest.current = activeKey;
    if (draining.current) return; // 已有循环在跑,它每轮读 latest 会自己追上
    draining.current = true;
    (async () => {
      // 一直把画面收敛到 latest —— 切换途中连点会更新 latest,循环下一轮直接奔最新。
      while (alive.current && latest.current !== shownRef.current) {
        const target = latest.current;
        setMounted((m) => (m.has(target) ? m : new Set(m).add(target)));
        const entered = new Promise<void>((res) => enterResolvers.current.set(target, res));
        setIncoming(target); // 目标面板转 entering → 它自己立刻播入场(不等架子;架子没到先显骨架)
        await entered; // 面板播完 onEntered 时 resolve
        if (!alive.current) break;
        shownRef.current = target;
        setShown(target); // 目标 → shown;旧页转 hidden 隐藏保活
        setIncoming(null);
      }
      draining.current = false;
    })();
  }, [activeKey]);

  const onEntered = (key: string) => {
    const res = enterResolvers.current.get(key);
    if (res) {
      enterResolvers.current.delete(key);
      res();
    }
  };
  const stateOf = (key: string): PanelState =>
    key === incoming ? "entering" : key === shown ? "shown" : "hidden";

  return (
    // isolation:isolate 把面板内部的 zIndex 关在自己层里 —— 绝不逃出去盖到外面 fixed 的 Dock(逃出去 iOS 上会闪)。
    <div style={{ display: "grid", isolation: "isolate", position: "relative" }}>
      {pages
        .filter((p) => mounted.has(p.key))
        .map((p) => (
          <KeepAlivePanel
            key={p.key}
            panelKey={p.key}
            state={stateOf(p.key)}
            fallback={fallback}
            onEntered={onEntered}
          >
            <p.Component />
          </KeepAlivePanel>
        ))}
    </div>
  );
}
