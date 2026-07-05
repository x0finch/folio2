import { Card, CardContent, CardHeader, Skeleton } from "@folio/ui";

// 路由 pendingComponent 用的骨架态:形状贴合各页真实布局,避免加载时空白跳动。
// 稳定 key(避免 index key lint):占位行数固定,用字符串数组当 key。
const ROWS_5 = ["r1", "r2", "r3", "r4", "r5"];
const ROWS_4 = ["r1", "r2", "r3", "r4"];
const CARDS_2 = ["c1", "c2"];

function Row() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-4 w-20" />
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-40" />
          {ROWS_5.map((k) => (
            <Row key={k} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function AccountsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-9 w-24" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          {ROWS_4.map((k) => (
            <Row key={k} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function InsightsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      {CARDS_2.map((k) => (
        <Card key={k}>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-52 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
