import { queryOptions } from "@tanstack/react-query";
import { getSyncStatus } from "@/lib/server/sync";
import { STALE_TIME } from "./constants";
import { syncKeys } from "./keys";

// 同步域的读取入口 —— 与 `lib/server/sync` 的读取型 server fn 一一对应。
// 「这一页要什么数据」从路由文件挪到了这里(ADR 0038 的取舍),一个域一个文件。

// 同步域没有独立的写操作:它由「一轮同步」刷新,而那条路径本片就迁好了 ——
// 所以 staleTime 可以直接开,不用等别的片。
// 按 Portfolio 一份:切组合时 key 变 → 重新取一份该视图的摘要(ADR 0033)。前缀仍是
// `["sync","status"]`,所以刷新映射表那条域前缀照样盖得住全部。
export const syncStatusQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: syncKeys.status(portfolioId),
    queryFn: () => getSyncStatus({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });
