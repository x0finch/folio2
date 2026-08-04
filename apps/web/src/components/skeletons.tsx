import { Card, CardContent, CardHeader, Skeleton } from "@folio/ui";

// 路由 pendingComponent 用的骨架态:形状贴合各页真实布局,避免加载时空白跳动。
// 稳定 key(避免 index key lint):占位行数固定,用字符串数组当 key。
const ROWS_5 = ["r1", "r2", "r3", "r4", "r5"];
const ROWS_4 = ["r1", "r2", "r3", "r4"];
const ROWS_3 = ["r1", "r2", "r3"];
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
      {/* hero:趋势背景 + 净值/24h/三指标浮于其上 → 单块高占位 */}
      <Skeleton className="h-56 w-full rounded-xl" />
      {/* 持仓:pill tabs(左)+ 该视角合计(右)+ 行(无 Card) */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-64 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="flex flex-col gap-4">
          {ROWS_5.map((k) => (
            <Row key={k} />
          ))}
        </div>
      </div>
    </div>
  );
}

// 短列表骨架(3 行,无 Card):自定义 Tab 首次拉取过滤后内容时占位 —— 避免退回展示未收窄的全量数据。
export function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {ROWS_3.map((k) => (
        <Row key={k} />
      ))}
    </div>
  );
}

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
