import { Card, CardContent, CardHeader, Skeleton } from "@folio/ui";

// 跨页共用 / 非首页的骨架。
const ROWS_4 = ["r1", "r2", "r3", "r4"];
const CARDS_2 = ["c1", "c2"];

// 账户行骨架:贴合 v2 行(无前导头像)—— 左 名称/状态/代币叠标,右 市值/增量;无 Card,与真实列表同 padding。
function AccountRow() {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-3">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-3 w-14" />
      </div>
    </div>
  );
}

export function AccountsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-40" />
      <div className="flex flex-col">
        {ROWS_4.map((k) => (
          <AccountRow key={k} />
        ))}
      </div>
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
