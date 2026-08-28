"use client";

import { useEffect, useState } from "react";
import { useFormatter, useNow } from "use-intl";

// 「同步于 X 前」的相对时间格式化 —— 四处同一个坑,收成一份(FOL-32 二轮 review A3/A4)。
//
// 为什么不用裸 useNow({ updateInterval }):
// ① provider 的 now 冻在**页面加载**那一刻。页面开着不关,刚落库的快照比它还新,渲染成
//    「in 2 minutes」这种未来时态(生产实测抓到)。
// ② useNow 的 interval 版也治不好**晚挂载**:它的初值仍是 provider 那份 —— 页面开了十分钟才打开
//    详情抽屉,抽屉头一分钟里写的还是十分钟前的「当下」,要等第一跳 tick 才自愈。
// 所以自己养一份 clientNow:挂载后立刻取真实当下,之后每分钟 tick(粒度与展示单位一致)。
// SSR / hydration 用 provider 那份垫底(两端一致,不然 hydration 对不上)。
//
// 钳到 now(Math.min)也收在这里:快照落库到下一跳 tick 之间,新时间戳照样比 now 新 ——
// 活时钟只是把窗口从「页面寿命」缩到「一跳之内」,钳位才是把未来时态堵死的那一下。
const TICK_MS = 60_000;

export function useRelativeSyncedAt(): (timestampMs: number) => string {
  const format = useFormatter();
  // 不带 updateInterval:这份只当 SSR/hydration 的垫底初值,活时钟在下面自己养。
  const providerNow = useNow();
  const [clientNow, setClientNow] = useState<Date | null>(null);

  useEffect(() => {
    // 挂载立刻对表 —— 晚挂载的组件(详情抽屉)一出场就是真实当下,不用等第一跳 tick。
    setClientNow(new Date());
    const timer = setInterval(() => setClientNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const now = clientNow ?? providerNow;
  return (timestampMs) => format.relativeTime(new Date(Math.min(timestampMs, now.getTime())), now);
}
