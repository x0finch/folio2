import { Skeleton } from "@folio/ui";

// 首访某 page、它的 chunk 还在下载时的内容占位(FOL-81)。放在外壳 <main> 内,只占内容区
// (外壳、导航、Dock 已在 AppShell 里渲好)。chunk 一到、组件挂载,页面自己 QueryBoundary 那套
// 骨架接手数据态;去过的页由 <Activity> 保活,回访不再经这里。形状对齐总览(内容最密的一页)。
const ROWS = ["r1", "r2", "r3", "r4", "r5"];

export function PageContentSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="min-h-60 w-full" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64 rounded-full" />
        <div className="flex flex-col">
          {ROWS.map((k) => (
            <div key={k} className="flex items-center gap-3 px-3 py-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-12" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
