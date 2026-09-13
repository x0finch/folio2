import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { DEFAULT_TAB } from "./home-tabs";

// 首页两个页内子状态的家(FOL-80,反转 ADR 0043):主 tab「视角」与代币详情抽屉。
//
// 以前住 URL(`?tab=` / `?token=`,ADR 0043);现在住组件内部 state。事实源是这份 state,不是地址。
// 一个路由 + `<Activity>` 保活之后(FOL-81),切走再回来由 Activity 把这份 state 留着 —— 不再需要
// URL 来记「刷新回原 tab」。代价是这两样不再进地址栏、不可深链/分享,这正是 ADR 0043 反转掉的东西。
//
// - `tab`:"tokens" / "perps" / "defi"(视角)或 pin id(自定义 Tab);默认 `tokens`。合法值含运行时
//   的 pin id,认不出的值(pin 被删)由消费方的 `pickShownTab` 回落,不在这里判。
// - `token`:代币详情抽屉开着哪个币的分组键(`Holding.key`);`undefined` = 没开。认不出的由消费方
//   当作没开(两个 TokenHoldings 实例各拿一份 holdings,同一个 key 在哪份里认得出是各自的事)。

interface HomeViewState {
  tab: string;
  setTab: (v: string) => void;
  token: string | undefined;
  setToken: (v: string | undefined) => void;
}

const HomeViewStateContext = createContext<HomeViewState | null>(null);

export function HomeViewStateProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<string>(DEFAULT_TAB);
  const [token, setToken] = useState<string | undefined>(undefined);
  const value = useMemo(() => ({ tab, setTab, token, setToken }), [tab, token]);
  return <HomeViewStateContext.Provider value={value}>{children}</HomeViewStateContext.Provider>;
}

export function useHomeViewState(): HomeViewState {
  const ctx = useContext(HomeViewStateContext);
  if (!ctx) throw new Error("useHomeViewState must be used within HomeViewStateProvider");
  return ctx;
}
