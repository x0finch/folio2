import type { UseQueryResult } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

// 岛屿式读取的一层收窄:**补水完成之前恒报 pending**。
//
// 要修的是首屏那几条 hydration mismatch(Overview / Accounts / Insights 各有)。成因不是这些
// 组件写错了,是**服务端与客户端补水那一帧看到的缓存不一样**:
//
//   · loader 把这些非挂起查询**发出去就返回**(`ensureQueryData` 不 await,#488 要的「壳立刻
//     出现」)。等那个挂起的总览回来时,它们通常也回来了 —— 于是**服务端渲染时有数据**。
//   · 客户端补水那一帧读的是脱水下来的缓存,里面还没有它们 —— **客户端没数据**。
//
// 一边画值、一边画骨架,React 于是把整棵子树丢掉重渲(控制台一条 mismatch,外加一次白干的
// 渲染和一次闪烁)。
//
// **修法是让服务端也画骨架**,而不是反过来让客户端等数据:骨架本来就是这些岛屿的设计首帧,
// 而客户端补水那一帧无论如何都没有数据 —— 所以画面上看到的东西不变,少的只是那次重渲。
//
// `useSyncExternalStore` 的第三个参数就是「服务端 / 补水那一帧读什么」—— React 为这件事留的
// 口子:补水时用 `getServerSnapshot`,补完自动切到 `getSnapshot` 并触发一次重渲。
// `useState` + `useEffect` 也能得到同样的两帧,但那是绕着走。

/** 这些岛屿真正用到的三样。**故意不透传整个 `UseQueryResult`** —— 补水前那一帧没有「真实的」
 * 查询状态可给,硬造一个完整的出来只会让人以为 `refetch` 之类在那一帧也是可信的。 */
export interface IslandQuery<T> {
  readonly data: T | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

// 状态永不变,所以退订是个空函数;这里要的只是 React 那两个 snapshot 分支。
const subscribe = () => () => {};

/** 「补水完成了没」。SSR 与客户端补水那一帧都是 `false`,补完变 `true`。 */
const useHydrated = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

/**
 * 用法:`const gain = useIslandQuery(useQuery(portfolioGain24hQuery(id)));`
 *
 * 包在 `useQuery` 外面而不是替掉它 —— 查询本身该怎么配(`staleTime`、`KEEP_TRYING`)是调用点
 * 的事,这一层只管「补水那一帧对外说什么」。
 */
export function useIslandQuery<T>(query: UseQueryResult<T>): IslandQuery<T> {
  const hydrated = useHydrated();
  if (!hydrated) return { data: undefined, isPending: true, isError: false };
  return { data: query.data, isPending: query.isPending, isError: query.isError };
}
