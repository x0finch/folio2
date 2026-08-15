import { useEffect, useState } from "react";

// 「这一帧是 hydration 那一帧吗」。挂载前恒 false —— 与 SSR 那一帧一致;挂载后 true。
//
// **它治的是非挂起读 + SSR 的一个必然错位**:`useQuery` 在服务端不等数据,SSR 那一帧拿到的是
// pending;而数据经 query 流补到客户端之后,客户端的第一帧已经有数据了。两帧渲染出的 DOM 不同,
// React 就报 hydration mismatch 并把整棵子树重画一遍 —— 不只是控制台一条告警,是首屏白扔一次渲染。
//
// 用它把「有数据」的分支推迟一帧,与 SSR 对齐,下一帧再换成真内容。同门做法见 hooks/use-theme
// 的 `useMountedTheme`(那边是 localStorage 在 SSR 期不可读,形状一样)。
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
