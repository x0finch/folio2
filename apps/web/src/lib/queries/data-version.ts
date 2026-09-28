import { type QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import type { dataVersionKeys } from "./keys";
import { invalidateFor } from "./refresh";

// **数据版本号驱动的刷新**(FOL-94)。
//
// 免费档一请求只有 10ms CPU、一天十万请求,而数据只在「有人写」的时候变(每小时一轮同步、手动改)。
// 以前靠时间猜 —— 30 秒一过,回到页面就把挂着的十来条查询全部重拉一遍。现在只问一个数:
// 服务端每次用户可见的写都在同一个事务里把它 +1(库里的触发器,`@folio/db` 迁移 0010),这里
// 回到页面 / 可见时每分钟问一次,**号变了**才失效那批数据查询(`REFRESH_MAP["data.changed"]`)。
//
// **拿什么比**:缓存里那一份号。页面冷开时它来自 IndexedDB(`persist.ts`)—— 也就是上次关页面
// 时看到的号 —— 所以「重开页面、数据没变」只多一发版本号;变了,就在旧数据先画出来的同时重拉。
// 缓存里没有号(头一回打开 / 持久化被清过)时第一次读到的号只记下、不失效:那时数据本来就是刚拉的。
//
// **本页自己的写会让它再刷一次**:mutation 成功后 `invalidateFor` 先定向刷一批,下一次问号时
// 号也变了,于是整批再失效一次。这是有意接受的代价(一次编辑多一轮,且只刷挂着的查询):
// 想省掉它就得分辨「这次 +1 是不是我自己写的」,而同一时刻后台同步也可能在写 —— 猜错了就是
// 漏刷,漏刷不报错。

/** 版本号查询的形状。queryFn 由调用方给:它是个 server fn,这个文件得在 node 单测里 import 得动。 */
export type DataVersionOptions = QueryObserverOptions<{ version: number }> & {
  queryKey: typeof dataVersionKeys.all;
};

/**
 * 盯着版本号:号变了 → `invalidateFor(queryClient, "data.changed")`。返回退订函数。
 *
 * 用 `QueryObserver` 而不是组件里 `useQuery` + `useEffect` 比较:比较那一步不是渲染的事,
 * 挂在观察者回调上就不必为它攒一份 state;也让它能在没有 React 的单测里跑。
 */
export function watchDataVersion(
  queryClient: QueryClient,
  options: DataVersionOptions,
): () => void {
  let seen = queryClient.getQueryData<{ version: number }>(options.queryKey)?.version;
  const observer = new QueryObserver(queryClient, options);
  return observer.subscribe((result) => {
    if (result.status !== "success" || result.isFetching) return;
    const next = result.data.version;
    if (seen === next) return;
    const had = seen !== undefined;
    seen = next;
    if (had) void invalidateFor(queryClient, "data.changed");
  });
}
